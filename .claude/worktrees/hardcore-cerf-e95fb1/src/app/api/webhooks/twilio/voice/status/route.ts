import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import type { CallRecord, CallStatus } from '@/lib/types/database';

// Terminal states: once dial-action sets one of these, do not overwrite.
const TERMINAL_STATUSES: CallStatus[] = ['completed', 'no_answer', 'busy', 'failed', 'canceled'];
const TERMINAL_WEBHOOK_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const CALLBACK_STATUS_MAP: Record<string, CallStatus> = {
  initiated: 'ringing',
  queued: 'ringing',
  ringing: 'ringing',
  answered: 'in_progress',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
};

type StatusRecord = Pick<
  CallRecord,
  'status' | 'direction' | 'from_number' | 'to_number' | 'queue_id' | 'answered_by_user_id' | 'duration' | 'answered_at' | 'ended_at'
>;

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value || '').trim()).filter(Boolean))];
}

function isTerminalWebhookStatus(status: string): boolean {
  return TERMINAL_WEBHOOK_STATUSES.includes(status);
}

function mapTwilioStatusToCallStatus(status: string): CallStatus {
  if (status === 'no-answer') return 'no_answer';
  return status as CallStatus;
}

function mapWebhookStatusToCallStatus(status: string): CallStatus | null {
  return CALLBACK_STATUS_MAP[status] ?? null;
}

async function resolveTrackedCallForStatus(params: {
  callSid: string;
  parentCallSid: string;
}): Promise<{ trackedCallSid: string; currentRecord: StatusRecord | null }> {
  const supabase = createAdminClient();
  const candidates = uniqueNonEmpty([params.parentCallSid, params.callSid]);

  for (const sid of candidates) {
    const { data } = await supabase
      .from('call_records')
      .select('status, direction, from_number, to_number, queue_id, answered_by_user_id, duration, answered_at, ended_at')
      .eq('twilio_call_sid', sid)
      .maybeSingle();

    if (data) {
      return {
        trackedCallSid: sid,
        currentRecord: data as StatusRecord,
      };
    }
  }

  // Fallback: some callbacks may arrive using agent leg SID.
  for (const sid of candidates) {
    const { data } = await supabase
      .from('call_records')
      .select('twilio_call_sid, status, direction, from_number, to_number, queue_id, answered_by_user_id, duration, answered_at, ended_at')
      .filter('twilio_data->>agent_call_sid', 'eq', sid)
      .maybeSingle();

    if (data?.twilio_call_sid) {
      return {
        trackedCallSid: data.twilio_call_sid,
        currentRecord: data as unknown as StatusRecord,
      };
    }
  }

  const fallbackSid = candidates[0] || '';
  return { trackedCallSid: fallbackSid, currentRecord: null };
}

/**
 * POST /api/webhooks/twilio/voice/status
 * Twilio notifies intermediate and terminal call status changes here.
 */
export async function POST(req: NextRequest) {
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;
  const { searchParams } = new URL(req.url);

  const rawCallSid = params.CallSid || '';
  const rawParentCallSid = params.ParentCallSid || '';
  const routedParentCallSid = (searchParams.get('parent_call_sid') || '').trim();
  const queueStrategyHint = (searchParams.get('queue_strategy') || '').trim();
  const attemptIdHint = (searchParams.get('attempt_id') || '').trim();
  const targetUserIdHint = (searchParams.get('target_user_id') || '').trim();
  const callStatus = params.CallStatus || '';
  const callDuration = params.CallDuration ? parseInt(params.CallDuration, 10) : 0;
  const normalizedDuration = Number.isFinite(callDuration) ? callDuration : 0;
  const timestamp = params.Timestamp || new Date().toISOString();

  const { trackedCallSid, currentRecord } = await resolveTrackedCallForStatus({
    callSid: rawCallSid,
    parentCallSid: routedParentCallSid || rawParentCallSid,
  });

  console.log(
    `[STATUS] raw_call_sid=${rawCallSid || '-'} raw_parent_call_sid=${rawParentCallSid || '-'} routed_parent_call_sid=${routedParentCallSid || '-'} tracked_call_sid=${trackedCallSid || '-'} status=${callStatus}`
  );

  if (!trackedCallSid) {
    // Silent drop produces "ghost busy" states if the record exists under a SID we did not resolve.
    // Log loudly so the pattern is visible in production logs and we can detect lost webhooks.
    console.warn(
      `[STATUS][DROP] No tracked call_record for webhook raw_call_sid=${rawCallSid || '-'} raw_parent_call_sid=${rawParentCallSid || '-'} status=${callStatus || '-'} timestamp=${timestamp}`
    );
    return new NextResponse('OK', { status: 200 });
  }

  // Conference status callbacks (join/leave/end) may hit this endpoint without CallStatus.
  // They are informative for observability, but must not overwrite call_records status.
  if (!callStatus) {
    console.log(
      `[STATUS] Ignoring callback without CallStatus raw_call_sid=${rawCallSid || '-'} tracked_call_sid=${trackedCallSid || '-'}`
    );
    return new NextResponse('OK', { status: 200 });
  }

  try {
    const supabase = createAdminClient();
    const currentStatus = currentRecord?.status;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // Round-robin advance: if an agent leg attempt ends without answer, immediately
    // force the parent caller leg to fetch /queue-retry so the next operator is rung.
    const shouldTryRoundRobinAdvance = (
      queueStrategyHint === 'round_robin'
      && !!routedParentCallSid
      && !!attemptIdHint
      && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)
      && (callStatus !== 'completed' || normalizedDuration === 0)
    );

    if (shouldTryRoundRobinAdvance) {
      const { data: parentRecord } = await supabase
        .from('call_records')
        .select('status, answered_by_user_id, twilio_data')
        .eq('twilio_call_sid', routedParentCallSid)
        .maybeSingle();

      const parentStatus = (parentRecord as { status?: CallStatus } | null)?.status;
      const parentAnsweredByUserId = (parentRecord as { answered_by_user_id?: string | null } | null)?.answered_by_user_id ?? null;
      const parentTwilioDataRaw = (parentRecord as { twilio_data?: unknown } | null)?.twilio_data;
      const parentTwilioData = (
        parentTwilioDataRaw
        && typeof parentTwilioDataRaw === 'object'
        && !Array.isArray(parentTwilioDataRaw)
      )
        ? (parentTwilioDataRaw as Record<string, unknown>)
        : {};
      const currentAttemptId = typeof parentTwilioData.current_round_robin_attempt_id === 'string'
        ? parentTwilioData.current_round_robin_attempt_id
        : null;

      if (
        currentAttemptId === attemptIdHint
        && !parentAnsweredByUserId
        && parentStatus !== 'in_progress'
        && parentStatus !== 'completed'
      ) {
        const consumedTwilioData = {
          ...parentTwilioData,
          current_round_robin_attempt_id: null,
          last_round_robin_attempt_id: attemptIdHint,
          last_round_robin_attempt_result: callStatus,
          last_round_robin_attempt_finished_at: new Date().toISOString(),
          last_round_robin_attempt_target_user_id: targetUserIdHint || null,
          last_round_robin_attempt_agent_call_sid: rawCallSid || null,
        };

        const { data: consumeResult } = await supabase
          .from('call_records')
          .update({
            status: 'in_queue',
            twilio_data: consumedTwilioData,
          })
          .eq('twilio_call_sid', routedParentCallSid)
          .is('answered_by_user_id', null)
          .filter('twilio_data->>current_round_robin_attempt_id', 'eq', attemptIdHint)
          .select('twilio_call_sid')
          .maybeSingle();

        if (consumeResult?.twilio_call_sid) {
          try {
            const client = getTwilioClient();
            await client.calls(routedParentCallSid).update({
              url: `${baseUrl}/api/webhooks/twilio/voice/queue-retry`,
              method: 'POST',
            });
            console.log(
              `[STATUS] Round-robin advance triggered parent_call_sid=${routedParentCallSid} attempt_id=${attemptIdHint} call_status=${callStatus}`
            );
            return new NextResponse('OK', { status: 200 });
          } catch (advanceErr) {
            console.error(
              `[STATUS] Round-robin advance failed parent_call_sid=${routedParentCallSid}: ${
                advanceErr instanceof Error ? advanceErr.message : 'unknown_error'
              } — scheduling fallback retry`
            );
            // Retry the redirect after a short delay
            try {
              const client2 = getTwilioClient();
              await new Promise(resolve => setTimeout(resolve, 2000));
              await client2.calls(routedParentCallSid).update({
                url: `${baseUrl}/api/webhooks/twilio/voice/queue-retry`,
                method: 'POST',
              });
              console.log(`[STATUS] Fallback round-robin retry succeeded for ${routedParentCallSid}`);
            } catch (retryErr) {
              console.error(
                `[STATUS] Fallback round-robin retry also failed for ${routedParentCallSid}: ${
                  retryErr instanceof Error ? retryErr.message : 'unknown_error'
                }`
              );
            }
          }
        }
      }
    }

    if (currentStatus && TERMINAL_STATUSES.includes(currentStatus)) {
      if (!currentRecord?.ended_at && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
        await updateCallStatus(trackedCallSid, { endedAt: timestamp });
      }
      console.log(`[STATUS] Skipping - dial-action already set terminal status: ${currentStatus}`);
      return new NextResponse('OK', { status: 200 });
    }

    // --- GUARD: agent-leg status must NOT overwrite the parent call record ---
    // When the rawCallSid (the leg that finished) is different from the trackedCallSid
    // (the parent call record), this is an agent ring leg ending (timeout, cancel, etc.).
    // The parent call (caller in conference) is still alive — do NOT mark it terminal.
    // Only round-robin advance (handled above) and agent-connect should touch the parent.
    const isAgentLeg = rawCallSid !== trackedCallSid;
    const isAgentLegTerminal = isAgentLeg && isTerminalWebhookStatus(callStatus);
    const parentStillWaiting = currentStatus === 'ringing' || currentStatus === 'in_queue' || currentStatus === 'in_progress';

    if (isAgentLegTerminal && parentStillWaiting) {
      // If parent is actually terminal in Twilio, reconcile immediately.
      // This avoids "busy ghost" states when parent terminal callbacks are delayed/missing.
      if (currentStatus === 'in_progress') {
        try {
          const liveParentCall = await getTwilioClient().calls(trackedCallSid).fetch();
          const liveParentStatus = (liveParentCall.status || '').toLowerCase();

          if (isTerminalWebhookStatus(liveParentStatus)) {
            const endedAt = liveParentCall.endTime
              ? new Date(liveParentCall.endTime).toISOString()
              : timestamp;
            const parsedDuration = parseInt(String(liveParentCall.duration ?? '0'), 10);
            const safeDuration = Number.isFinite(parsedDuration) ? parsedDuration : 0;
            const terminalStatus = mapTwilioStatusToCallStatus(liveParentStatus);

            await updateCallStatus(trackedCallSid, {
              status: terminalStatus,
              endedAt,
              duration: safeDuration,
            });

            if (currentRecord?.direction === 'inbound' && terminalStatus !== 'completed') {
              emitEvent('call.missed', {
                call_sid: trackedCallSid,
                direction: currentRecord.direction,
                from: currentRecord.from_number ?? null,
                to: currentRecord.to_number ?? null,
                final_status: terminalStatus,
                queue_id: currentRecord.queue_id ?? null,
                terminal_source: 'agent_leg_reconcile',
              });
            } else if (currentRecord) {
              emitEvent('call.completed', {
                call_sid: trackedCallSid,
                direction: currentRecord.direction,
                status: terminalStatus,
                from: currentRecord.from_number ?? null,
                to: currentRecord.to_number ?? null,
                queue_id: currentRecord.queue_id ?? null,
                answered_by_user_id: currentRecord.answered_by_user_id ?? null,
                duration: safeDuration,
                wait_time: null,
                answered_at: currentRecord.answered_at ?? null,
                ended_at: endedAt,
                terminal_source: 'agent_leg_reconcile',
              });
            }

            console.log(
              `[STATUS] Reconciled parent terminal from agent-leg callback tracked_call_sid=${trackedCallSid} live_parent_status=${liveParentStatus}`
            );
            return new NextResponse('OK', { status: 200 });
          }
        } catch (reconcileErr) {
          console.warn(
            `[STATUS] Failed reconciling parent status from agent-leg callback tracked_call_sid=${trackedCallSid}: ${
              reconcileErr instanceof Error ? reconcileErr.message : 'unknown_error'
            }`
          );
        }
      }

      console.log(
        `[STATUS] Ignoring agent-leg terminal status — raw_call_sid=${rawCallSid} tracked_call_sid=${trackedCallSid} agent_status=${callStatus} parent_status=${currentStatus}`
      );
      return new NextResponse('OK', { status: 200 });
    }

    // Safety net for false terminal callbacks:
    // if we are marked in_progress but Twilio still reports the tracked leg as live,
    // ignore this callback to avoid cutting calls during remote hold/transfer flows.
    if (currentStatus === 'in_progress' && isTerminalWebhookStatus(callStatus)) {
      try {
        const live = await getTwilioClient().calls(trackedCallSid).fetch();
        const liveStatus = (live.status || '').toLowerCase();
        const liveIsTerminal = isTerminalWebhookStatus(liveStatus);

        if (!liveIsTerminal) {
          console.log(
            `[STATUS] Ignoring stale terminal callback call_sid=${trackedCallSid} callback_status=${callStatus} live_status=${liveStatus}`
          );
          return new NextResponse('OK', { status: 200 });
        }
      } catch (liveErr) {
        console.warn(
          `[STATUS] Could not verify live call status for ${trackedCallSid}: ${
            liveErr instanceof Error ? liveErr.message : 'unknown_error'
          }`
        );
      }
    }

    const mappedStatus = mapWebhookStatusToCallStatus(callStatus);
    if (!mappedStatus) {
      console.warn(
        `[STATUS] Ignoring unsupported CallStatus raw=${callStatus} raw_call_sid=${rawCallSid || '-'} tracked_call_sid=${trackedCallSid || '-'}`
      );
      return new NextResponse('OK', { status: 200 });
    }

    const updates: Parameters<typeof updateCallStatus>[1] = {
      status: mappedStatus,
    };

    // Outbound answered transition used by RDN/UI (ringing -> in_progress).
    if (callStatus === 'in-progress' && currentRecord?.direction === 'outbound') {
      if (!currentRecord.answered_at) {
        updates.answeredAt = timestamp;
      }

      const agentUserId = currentRecord.answered_by_user_id ?? null;

      let rdnUserId: string | null = null;
      if (agentUserId) {
        const { data: agentData } = await supabase
          .from('users')
          .select('rdn_user_id')
          .eq('id', agentUserId)
          .single();
        rdnUserId = (agentData as { rdn_user_id?: string } | null)?.rdn_user_id ?? null;
      }

      console.log(
        `[STATUS] Outbound call answered - emitting call.answered call_sid=${trackedCallSid} agent=${agentUserId}`
      );

      emitEvent('call.answered', {
        call_sid: trackedCallSid,
        direction: 'outbound',
        status: 'in_progress',
        from: currentRecord.from_number ?? null,
        to: currentRecord.to_number ?? null,
        answered_by_user_id: agentUserId,
        user_id: agentUserId,
        rdn_user_id: rdnUserId,
      });
    }

    if (isTerminalWebhookStatus(callStatus)) {
      if (!currentRecord?.ended_at) {
        updates.endedAt = timestamp;
      }
      if (currentRecord?.duration === null || currentRecord?.duration === undefined) {
        const callDuration = params.CallDuration ? parseInt(params.CallDuration, 10) : undefined;
        if (callDuration !== undefined) {
          updates.duration = callDuration;
        }
      }
    }

    await updateCallStatus(trackedCallSid, updates);

    const isTerminalFromStatus = isTerminalWebhookStatus(callStatus);
    if (isTerminalFromStatus && currentRecord) {
      const direction = currentRecord?.direction || 'outbound';
      const terminalStatus = mappedStatus as CallStatus;
      const endedAt = updates.endedAt || currentRecord?.ended_at || timestamp;
      const answeredAt = currentRecord?.answered_at || null;
      const duration = updates.duration ?? currentRecord?.duration ?? 0;

      console.log(
        `[STATUS] terminal fallback emit call_sid=${trackedCallSid} direction=${direction} status=${terminalStatus}`
      );

      if (direction === 'inbound' && terminalStatus !== 'completed') {
        emitEvent('call.missed', {
          call_sid: trackedCallSid,
          direction,
          from: currentRecord?.from_number ?? null,
          to: currentRecord?.to_number ?? null,
          final_status: terminalStatus,
          queue_id: currentRecord?.queue_id ?? null,
          terminal_source: 'status_fallback',
        });
      } else {
        emitEvent('call.completed', {
          call_sid: trackedCallSid,
          direction,
          status: terminalStatus,
          from: currentRecord?.from_number ?? null,
          to: currentRecord?.to_number ?? null,
          queue_id: currentRecord?.queue_id ?? null,
          answered_by_user_id: currentRecord?.answered_by_user_id ?? null,
          duration,
          wait_time: null,
          answered_at: answeredAt,
          ended_at: endedAt,
          terminal_source: 'status_fallback',
        });
      }
    }
  } catch (err) {
    console.error('[STATUS] Error updating call status:', err);
  }

  return new NextResponse('OK', { status: 200 });
}

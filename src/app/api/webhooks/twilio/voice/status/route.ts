import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { CallRecord, CallStatus } from '@/lib/types/database';

// Terminal states: once dial-action sets one of these, do not overwrite.
const TERMINAL_STATUSES: CallStatus[] = ['completed', 'no_answer', 'busy', 'failed', 'canceled'];

type StatusRecord = Pick<
  CallRecord,
  'status' | 'direction' | 'from_number' | 'to_number' | 'queue_id' | 'answered_by_user_id' | 'duration' | 'answered_at' | 'ended_at'
>;

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value || '').trim()).filter(Boolean))];
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

  const rawCallSid = params.CallSid || '';
  const rawParentCallSid = params.ParentCallSid || '';
  const callStatus = params.CallStatus || '';
  const timestamp = params.Timestamp || new Date().toISOString();

  const { trackedCallSid, currentRecord } = await resolveTrackedCallForStatus({
    callSid: rawCallSid,
    parentCallSid: rawParentCallSid,
  });

  console.log(
    `[STATUS] raw_call_sid=${rawCallSid || '-'} raw_parent_call_sid=${rawParentCallSid || '-'} tracked_call_sid=${trackedCallSid || '-'} status=${callStatus}`
  );

  if (!trackedCallSid) {
    return new NextResponse('OK', { status: 200 });
  }

  try {
    const supabase = createAdminClient();
    const currentStatus = currentRecord?.status;

    if (currentStatus && TERMINAL_STATUSES.includes(currentStatus)) {
      if (!currentRecord?.ended_at && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
        await updateCallStatus(trackedCallSid, { endedAt: timestamp });
      }
      console.log(`[STATUS] Skipping - dial-action already set terminal status: ${currentStatus}`);
      return new NextResponse('OK', { status: 200 });
    }

    const statusMap: Record<string, string> = {
      queued: 'ringing',
      ringing: 'ringing',
      'in-progress': 'in_progress',
      completed: 'completed',
      busy: 'busy',
      'no-answer': 'no_answer',
      failed: 'failed',
      canceled: 'canceled',
    };

    const mappedStatus = statusMap[callStatus] || callStatus;
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

    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
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

    const isTerminalFromStatus = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus);
    if (isTerminalFromStatus) {
      const direction = currentRecord?.direction || 'outbound';
      const terminalStatus = mappedStatus;
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

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { claimTwilioWebhookEvent } from '@/lib/events/twilio-idempotency';
import {
  clearAgentLossMarker,
  handleAgentLegLeftRoom,
  sweepRoomWatchdog,
} from '@/lib/calls/room-watchdog';
import { scheduleRingWave } from '@/lib/calls/ring-wave';
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
  'id' | 'status' | 'direction' | 'from_number' | 'to_number' | 'queue_id' | 'answered_by_user_id' | 'duration' | 'answered_at' | 'ended_at'
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
      .select('id, status, direction, from_number, to_number, queue_id, answered_by_user_id, duration, answered_at, ended_at')
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
      .select('id, twilio_call_sid, status, direction, from_number, to_number, queue_id, answered_by_user_id, duration, answered_at, ended_at')
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
  const accountSid = params.AccountSid || '';
  const callDuration = params.CallDuration ? parseInt(params.CallDuration, 10) : 0;
  const normalizedDuration = Number.isFinite(callDuration) ? callDuration : 0;
  const timestamp = params.Timestamp || new Date().toISOString();

  // Idempotency: Twilio retries on transient errors and occasionally
  // double-fires callbacks. Dedup on (CallSid, CallStatus, AccountSid)
  // so the handler runs exactly once. Callbacks without CallStatus
  // (conference events) are not deduped — they carry no side-effect
  // weight on call_records.
  if (rawCallSid && callStatus && accountSid) {
    const dedup = await claimTwilioWebhookEvent({
      callSid: rawCallSid,
      callStatus,
      accountSid,
      source: 'voice/status',
      payload: params,
    });
    if (dedup.duplicate) {
      console.log(
        `[STATUS][IDEMPOTENT] Skipping duplicate callback call_sid=${rawCallSid} status=${callStatus} first_seen=${dedup.firstSeenAt ?? '-'}`,
      );
      return new NextResponse('OK', { status: 200 });
    }
  }

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

  // Update the freshness timestamp ONLY when this callback actually proves the
  // tracked (parent) call is alive. The reconcile self-heal reads
  // last_webhook_at to decide "is this call still live?"; if we stamp it for
  // every resolved callback, an agent RING leg (which resolves to the parent
  // via parent_call_sid) keeps the parent looking fresh even after the caller
  // has dropped — which blinds the self-heal and produces the "ghost busy"
  // agent. A callback proves parent liveness only when it is the parent leg's
  // own callback, or when a leg actually connected (answered / in-progress).
  const callbackProvesParentLive = (
    rawCallSid === trackedCallSid
    || callStatus === 'answered'
    || callStatus === 'in-progress'
  );
  if (callbackProvesParentLive) {
    try {
      const supabaseFreshness = createAdminClient();
      await supabaseFreshness
        .from('call_records')
        .update({ last_webhook_at: new Date().toISOString() })
        .eq('twilio_call_sid', trackedCallSid);
    } catch (err) {
      console.warn(`[STATUS] Failed updating last_webhook_at for ${trackedCallSid}:`, err);
    }
  }

  // Conference status callbacks (join/leave/end) hit this endpoint without
  // CallStatus. They must never overwrite call_records status, but son la
  // ÚNICA señal que tenemos sobre la membresía de la sala. Antes se
  // descartaban, lo que nos dejaba ciegos ante (a) la leg del agente
  // cayéndose sin hangup y (b) PBXs externas que aparcan la leg del
  // llamante durante un hold remoto. Ahora se persisten en
  // conference_events para diagnóstico y para el futuro watchdog de sala.
  if (!callStatus) {
    const conferenceEvent = (params.StatusCallbackEvent || '').trim();
    if (!conferenceEvent) {
      console.log(
        `[STATUS] Ignoring callback without CallStatus raw_call_sid=${rawCallSid || '-'} tracked_call_sid=${trackedCallSid || '-'}`
      );
      return new NextResponse('OK', { status: 200 });
    }

    try {
      const supabase = createAdminClient();
      const friendlyName = (params.FriendlyName || '').trim() || null;

      // call-<sid> (entrantes) y resume-<sid>-<ts> (re-puenteos tras hold)
      // codifican el twilio_call_sid canónico en el nombre de la sala.
      let parentFromName: string | null = null;
      if (friendlyName?.startsWith('call-')) {
        parentFromName = friendlyName.slice('call-'.length);
      } else if (friendlyName?.startsWith('resume-')) {
        const match = friendlyName.match(/^resume-(.+)-\d+$/);
        parentFromName = match ? match[1] : null;
      }

      let isAgentLeg: boolean | null = null;
      let parentStatus: string | null = null;
      let parentEnded = false;
      let parentHasAgentLossMarker = false;
      if (parentFromName) {
        const { data: parentRow } = await supabase
          .from('call_records')
          .select('status, ended_at, twilio_data')
          .eq('twilio_call_sid', parentFromName)
          .maybeSingle();

        if (parentRow) {
          parentStatus = (parentRow.status as string | null) ?? null;
          parentEnded = Boolean(parentRow.ended_at);
          const parentData = (
            parentRow.twilio_data
            && typeof parentRow.twilio_data === 'object'
            && !Array.isArray(parentRow.twilio_data)
          ) ? (parentRow.twilio_data as Record<string, unknown>) : {};
          const agentLegSid = typeof parentData.agent_call_sid === 'string'
            ? parentData.agent_call_sid
            : null;
          parentHasAgentLossMarker = typeof parentData.agent_left_room_at === 'string'
            && parentData.agent_left_room_at.length > 0;

          if (rawCallSid && agentLegSid && rawCallSid === agentLegSid) {
            isAgentLeg = true;
          } else if (rawCallSid && rawCallSid === parentFromName) {
            isAgentLeg = false;
          }
        }
      }

      await supabase.from('conference_events').insert({
        conference_sid: params.ConferenceSid || null,
        friendly_name: friendlyName,
        event: conferenceEvent,
        participant_call_sid: rawCallSid || null,
        parent_call_sid: parentFromName,
        is_agent_leg: isAgentLeg,
        parent_status_at_event: parentStatus,
        reason: params.ReasonConferenceEnded || params.Reason || null,
        payload: params,
      });

      // Señal precursora del bug "se corta en espera": una leg sale de la
      // sala mientras el record sigue in_progress. Puede ser una carrera
      // benigna con el teardown (el terminal llega segundos después), pero
      // si aparece SIN terminal posterior es la pistola humeante: o la leg
      // del agente murió (red/WebView2) o la PBX remota aparcó al llamante.
      if (
        conferenceEvent === 'participant-leave'
        && parentStatus === 'in_progress'
        && !parentEnded
      ) {
        const who = isAgentLeg === true ? 'agent' : isAgentLeg === false ? 'caller' : 'unknown';
        console.warn(
          `[CONFERENCE][ANOMALY] participant-leave con llamada in_progress conference=${friendlyName ?? '-'} leg=${who} participant=${rawCallSid || '-'} parent=${parentFromName ?? '-'} reason=${params.ReasonConferenceEnded || params.Reason || '-'}`
        );

        // La leg del AGENTE se fue con la llamada en curso → room-watchdog:
        // gracia para el rejoin del softphone y, si no vuelve, re-encolar o
        // cerrar ordenadamente. (Las legs de agente ya no llevan
        // endConferenceOnExit, así que la sala sobrevive y alguien tiene
        // que ocuparse del llamante.)
        if (isAgentLeg === true && parentFromName && rawCallSid) {
          void handleAgentLegLeftRoom({
            parentCallSid: parentFromName,
            agentLegSid: rawCallSid,
            conferenceSid: params.ConferenceSid || null,
            friendlyName,
          }).catch((err) => {
            console.error('[STATUS] handleAgentLegLeftRoom falló:', err);
          });
        }
      }

      // Reincorporación: cualquier participante no-llamante que entra a la
      // sala con un marcador de pérdida pendiente lo desactiva (el caso
      // típico es el rejoin automático del Tauri con una leg nueva).
      if (
        conferenceEvent === 'participant-join'
        && parentFromName
        && parentHasAgentLossMarker
        && rawCallSid
        && rawCallSid !== parentFromName
      ) {
        void clearAgentLossMarker(parentFromName, 'participant_join').catch(() => {});
        console.log(
          `[ROOM-WATCHDOG] Marcador de pérdida limpiado: ${rawCallSid} se unió a ${friendlyName ?? '-'} (parent=${parentFromName}).`
        );
      }

      // Barrido oportunista (con debounce interno): red de seguridad para
      // timers perdidos en un reinicio del proceso.
      void sweepRoomWatchdog().catch(() => {});
    } catch (confErr) {
      console.warn(
        `[STATUS] Failed persisting conference event raw_call_sid=${rawCallSid || '-'}:`,
        confErr,
      );
    }

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

    // Avance de ring_all: a diferencia de round_robin (una sola leg por
    // intento, avance inmediato al fallar), ring_all debe esperar a que
    // TODAS las legs del intento terminen sin respuesta. Antes no existía
    // ningún avance para ring_all: si nadie contestaba la primera oleada,
    // el llamante quedaba en la conferencia escuchando música para siempre
    // (max_wait_time/timeout_action nunca llegaban a aplicarse).
    const shouldTryRingAllAdvance = (
      queueStrategyHint === 'ring_all'
      && !!routedParentCallSid
      && !!attemptIdHint
      && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)
      && (callStatus !== 'completed' || normalizedDuration === 0)
    );

    if (shouldTryRingAllAdvance) {
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
        const attemptLegSids = Array.isArray(parentTwilioData.current_ring_attempt_leg_sids)
          ? (parentTwilioData.current_ring_attempt_leg_sids as unknown[])
            .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0)
          : [];
        const siblingLegSids = attemptLegSids.filter((sid) => sid !== rawCallSid);

        // ¿Queda alguna leg hermana viva? Verificación en vivo contra la
        // API (tolerante a carreras: si dos legs terminan a la vez, ambas
        // pasan por aquí y solo una gana el consume guard de abajo).
        let anySiblingAlive = false;
        const twilioClientForAdvance = getTwilioClient();
        for (const siblingSid of siblingLegSids) {
          try {
            const sibling = await twilioClientForAdvance.calls(siblingSid).fetch();
            const siblingStatus = (sibling.status || '').toLowerCase();
            if (['queued', 'initiated', 'ringing', 'in-progress'].includes(siblingStatus)) {
              anySiblingAlive = true;
              break;
            }
          } catch {
            // 404/errores → tratar como leg muerta.
          }
        }

        if (anySiblingAlive) {
          console.log(
            `[STATUS] ring_all attempt ${attemptIdHint} aún tiene legs vivas para parent=${routedParentCallSid}; sin avance.`
          );
        } else {
          // HOTFIX PRO: el avance original redirigía al llamante a
          // queue-retry. Como las legs REST a client: fallan en ~2s (el
          // Tauri no registra Device; acepta por SSE), eso expulsaba al
          // llamante de la sala cada ~5s en bucle ("le estamos
          // transfiriendo" sin parar, accepts a salas vacías, RDN
          // enloquecido). Ahora el llamante NO SE MUEVE: se consume el
          // intento y se programa una ola de ring en sitio con cadencia
          // mínima (ring-wave.ts). El único redirect legítimo lo hace la
          // propia ola al superar max_wait con acción terminal.
          const consumedTwilioData = {
            ...parentTwilioData,
            current_round_robin_attempt_id: null,
            current_ring_attempt_leg_sids: [],
            last_ring_all_attempt_id: attemptIdHint,
            last_ring_all_attempt_result: callStatus,
            last_ring_all_attempt_finished_at: new Date().toISOString(),
          };

          const { data: consumeResult } = await supabase
            .from('call_records')
            .update({
              status: 'in_queue',
              twilio_data: consumedTwilioData,
            })
            .eq('twilio_call_sid', routedParentCallSid)
            .is('answered_by_user_id', null)
            .is('ended_at', null)
            .in('status', ['ringing', 'in_queue'] as CallStatus[])
            .filter('twilio_data->>current_round_robin_attempt_id', 'eq', attemptIdHint)
            .select('twilio_call_sid')
            .maybeSingle();

          if (consumeResult?.twilio_call_sid) {
            const attemptStartedAt = typeof parentTwilioData.current_round_robin_attempt_started_at === 'string'
              ? parentTwilioData.current_round_robin_attempt_started_at
              : null;
            // 25s ≈ ring_timeout típico; scheduleRingWave aplica además un
            // suelo de 15s, así que una desviación aquí solo afecta a la
            // cadencia, nunca produce bucles rápidos.
            scheduleRingWave(routedParentCallSid, attemptStartedAt, 25);
            console.log(
              `[STATUS] ring_all advance: intento ${attemptIdHint} agotado sin respuesta — ola en sitio programada para ${routedParentCallSid} (el llamante no sale de la sala).`
            );
            return new NextResponse('OK', { status: 200 });
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
              terminalSource: 'status_agent_leg_reconcile',
            });

            if (currentRecord?.direction === 'inbound' && terminalStatus !== 'completed') {
              emitEvent('call.missed', {
                call_sid: trackedCallSid,
                call_record_id: currentRecord.id,
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
                call_record_id: currentRecord.id,
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
      terminalSource: 'status_webhook',
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
        call_record_id: currentRecord.id,
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
          call_record_id: currentRecord.id,
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
          call_record_id: currentRecord.id,
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

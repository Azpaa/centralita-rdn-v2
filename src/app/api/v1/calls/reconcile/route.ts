import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiForbidden, apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { emitEvent } from '@/lib/events/emitter';
import { drainReconcileOutbox } from '@/lib/events/reconcile-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lowered from 30 min → 2 min. A call stuck `in_progress` with no progress in 2 min
// is almost always a lost webhook, and leaving the operator blocked for 30 min is
// the dominant cause of the "ghost busy" state reported in production.
const STUCK_IN_PROGRESS_THRESHOLD_MINUTES = 2;

// Lowered from 10 min → 3 min. Ringing/in_queue beyond 3 min is effectively dead.
const STUCK_RINGING_THRESHOLD_MINUTES = 3;

/**
 * POST /api/v1/calls/reconcile
 *
 * Reconciles stuck calls:
 * - Finds call_records with status='in_progress' older than STUCK_IN_PROGRESS_THRESHOLD_MINUTES
 * - Checks real status via Twilio API
 * - Updates DB if Twilio says the call already ended
 * - Emits call.completed / call.missed SSE + webhooks
 *
 * Also reconciles stuck 'ringing'/'in_queue' calls older than STUCK_RINGING_THRESHOLD_MINUTES.
 *
 * Intended cadence: cron every 60 seconds (previously recommended 5 min — too slow
 * for the "ghost busy" problem caused by lost webhooks). Requires admin session or M2M API key.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  if (auth.authMethod === 'session' && auth.role !== 'admin') {
    return apiForbidden('Solo admin puede ejecutar reconciliación');
  }

  const supabase = createAdminClient();
  const twilioClient = getTwilioClient();

  let reconciled = 0;
  let checked = 0;
  const details: Array<{ call_sid: string; twilio_status: string; action: string }> = [];

  // --- 1. Reconcile stuck in_progress calls (>STUCK_IN_PROGRESS_THRESHOLD_MINUTES) ---
  const inProgressCutoff = new Date(Date.now() - STUCK_IN_PROGRESS_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuckInProgress, error: ipErr } = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, from_number, to_number, queue_id, answered_by_user_id, started_at')
    .eq('status', 'in_progress')
    .is('ended_at', null)
    .lt('started_at', inProgressCutoff)
    .order('started_at', { ascending: true })
    .limit(50);

  if (ipErr) {
    console.error('[RECONCILE] Error querying stuck in_progress calls:', ipErr);
  }

  // --- 2. Reconcile stuck ringing/in_queue calls (>STUCK_RINGING_THRESHOLD_MINUTES) ---
  const ringingCutoff = new Date(Date.now() - STUCK_RINGING_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuckRinging, error: ringErr } = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, from_number, to_number, queue_id, answered_by_user_id, started_at')
    .in('status', ['ringing', 'in_queue'])
    .is('ended_at', null)
    .lt('started_at', ringingCutoff)
    .order('started_at', { ascending: true })
    .limit(50);

  if (ringErr) {
    console.error('[RECONCILE] Error querying stuck ringing calls:', ringErr);
  }

  const allStuck = [...(stuckInProgress || []), ...(stuckRinging || [])];

  // Always drain the reconcile outbox before/after the sweep. The Supabase
  // edge cron is the primary writer; draining here catches any entries the
  // edge left pending (e.g. missing RDN webhook delivery) even when this
  // endpoint itself finds no stuck rows locally.
  const outboxBefore = await drainReconcileOutbox();

  if (allStuck.length === 0) {
    return apiSuccess({
      reconciled: 0,
      checked: 0,
      message: 'No stuck calls found',
      outbox: outboxBefore,
    });
  }

  for (const call of allStuck) {
    const callSid = call.twilio_call_sid;
    if (!callSid || callSid.startsWith('pending-')) continue;

    checked++;

    try {
      const twilioCall = await twilioClient.calls(callSid).fetch();
      const realStatus = twilioCall.status;

      if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(realStatus)) {
        const endedAt = twilioCall.endTime?.toISOString() || new Date().toISOString();
        const duration = twilioCall.duration ? parseInt(twilioCall.duration, 10) : 0;

        await updateCallStatus(callSid, {
          status: realStatus === 'no-answer' ? 'no_answer' : realStatus,
          endedAt,
          duration,
        });

        // Emit appropriate event
        if (call.direction === 'inbound' && realStatus !== 'completed') {
          emitEvent('call.missed', {
            call_sid: callSid,
            direction: call.direction,
            from: call.from_number,
            to: call.to_number,
            final_status: realStatus,
            queue_id: call.queue_id,
            reconciled: true,
          });
        } else {
          emitEvent('call.completed', {
            call_sid: callSid,
            direction: call.direction,
            status: realStatus,
            from: call.from_number,
            to: call.to_number,
            queue_id: call.queue_id,
            answered_by_user_id: call.answered_by_user_id,
            duration,
            ended_at: endedAt,
            reconciled: true,
          });
        }

        reconciled++;
        details.push({ call_sid: callSid, twilio_status: realStatus, action: 'reconciled' });
        console.log(`[RECONCILE] Reconciled ${callSid}: twilio_status=${realStatus}`);
      } else {
        details.push({ call_sid: callSid, twilio_status: realStatus, action: 'still_active' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.warn(`[RECONCILE] Error fetching Twilio status for ${callSid}: ${message}`);
      details.push({ call_sid: callSid, twilio_status: 'error', action: message });
    }
  }

  // A second drain after the sweep covers any new outbox rows that may
  // have landed while we were iterating (the edge cron runs on its own
  // schedule and may overlap ours).
  const outboxAfter = await drainReconcileOutbox();

  console.log(
    `[RECONCILE] Done: checked=${checked} reconciled=${reconciled} outbox_before=${outboxBefore.delivered}/${outboxBefore.drained} outbox_after=${outboxAfter.delivered}/${outboxAfter.drained}`,
  );
  return apiSuccess({
    reconciled,
    checked,
    total_stuck: allStuck.length,
    details,
    outbox: {
      before: outboxBefore,
      after: outboxAfter,
    },
  });
}

import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent, type EventType } from '@/lib/events/emitter';

/**
 * Reconcile outbox drainer.
 *
 * The Supabase Edge Function `reconcile-calls` writes terminal outcomes to
 * `reconcile_event_outbox` when it self-heals a stuck call (because it can't
 * call our Next.js emitter directly). Without a drainer, those rows sit
 * forever and RDN never learns the call is over — operators stay "busy" in
 * RDN, Tauri keeps the call card pinned, and the pipeline silently breaks.
 *
 * This module bridges the outbox to `emitEvent`, which does the full
 * downstream fanout (domain_events insert, SSE publish, webhook delivery).
 *
 * Drain policy:
 *  - Bounded batch so a backlog can't turn a single call into a multi-second
 *    stall on whatever code path triggered the drain.
 *  - Serial emits to keep downstream ordering stable per call_sid.
 *  - Mark each row delivered immediately after emit succeeds; on failure we
 *    leave it pending so the next drain retries.
 */

const DEFAULT_BATCH_LIMIT = 25;

type OutboxRow = {
  id: number;
  call_sid: string;
  event: 'call.completed' | 'call.missed';
  payload: Record<string, unknown>;
};

export type OutboxDrainResult = {
  drained: number;
  delivered: number;
  failed: number;
  skipped: number;
};

let drainInFlight: Promise<OutboxDrainResult> | null = null;

/**
 * Drain pending reconcile outbox entries.
 *
 * Idempotent across concurrent callers: if a drain is already in progress,
 * we return the in-flight promise rather than starting a second one. This
 * matters because we call this from SSE-connect, state endpoints, and a
 * dedicated cron endpoint — without coalescing they would stomp each other.
 */
export async function drainReconcileOutbox(limit: number = DEFAULT_BATCH_LIMIT): Promise<OutboxDrainResult> {
  if (drainInFlight) return drainInFlight;

  drainInFlight = (async () => {
    const result: OutboxDrainResult = { drained: 0, delivered: 0, failed: 0, skipped: 0 };
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from('reconcile_event_outbox')
      .select('id, call_sid, event, payload')
      .is('delivered_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.warn('[OUTBOX] Drain query failed:', error.message);
      return result;
    }

    const rows = (data ?? []) as OutboxRow[];
    if (rows.length === 0) return result;

    result.drained = rows.length;

    for (const row of rows) {
      const payload = normalizePayload(row.payload);
      if (!payload) {
        await markDelivered(row.id, 'invalid_payload');
        result.skipped += 1;
        continue;
      }

      try {
        await emitEvent(row.event as EventType, payload);
        await markDelivered(row.id, 'ok');
        result.delivered += 1;
      } catch (err) {
        console.warn(
          `[OUTBOX] Emit failed id=${row.id} call_sid=${row.call_sid} event=${row.event}:`,
          err,
        );
        result.failed += 1;
      }
    }

    if (result.delivered > 0 || result.failed > 0 || result.skipped > 0) {
      console.log(
        `[OUTBOX] drain drained=${result.drained} delivered=${result.delivered} failed=${result.failed} skipped=${result.skipped}`,
      );
    }

    return result;
  })();

  try {
    return await drainInFlight;
  } finally {
    drainInFlight = null;
  }
}

function normalizePayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return null;
  return obj;
}

async function markDelivered(id: number, outcome: string): Promise<void> {
  try {
    await createAdminClient()
      .from('reconcile_event_outbox')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', id)
      .is('delivered_at', null);
  } catch (err) {
    console.warn(`[OUTBOX] Failed marking row ${id} delivered (${outcome}):`, err);
  }
}

/**
 * Fire-and-forget helper for hot paths. Kicks off a drain without awaiting,
 * swallowing any error so the caller isn't impacted. Use this from SSE
 * connect and state endpoints; use `drainReconcileOutbox` directly when
 * you want the result (e.g. cron endpoint response).
 */
export function triggerReconcileOutboxDrainInBackground(reason: string): void {
  drainReconcileOutbox().catch((err) => {
    console.warn(`[OUTBOX] background drain (${reason}) error:`, err);
  });
}

import crypto from 'crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { CanonicalClientEvent } from './client-stream';

/**
 * Cross-worker SSE event fanout via Supabase Realtime broadcast.
 *
 * Why: our in-memory `client-stream` bus lives on `globalThis` and is
 * therefore per-Node-process. On Vercel serverless, the SSE connection
 * lives on one Lambda while incoming POSTs (accept, dial, webhook) land on
 * random Lambdas. Without cross-worker fanout, control events published on
 * one worker never reach subscribers listening on another — that was the
 * root cause of "RDN clicks accept but Tauri never picks up".
 *
 * Design:
 *  - Publish: use Supabase Realtime's REST broadcast endpoint. It's a
 *    one-shot HTTPS call, so a short-lived POST Lambda doesn't need to
 *    establish a persistent channel just to send one event. Bounded
 *    timeout so a hanging Supabase doesn't block the Twilio webhook.
 *  - Receive: use the Supabase JS client's channel subscription. SSE-serving
 *    Lambdas are long-lived while a client is connected, so a persistent
 *    channel is cheap and reliable there. We own the reconnect loop — a
 *    CLOSED socket on Vercel is frequent and has to be handled explicitly
 *    or the worker goes deaf until the Lambda restarts.
 *  - Self-loop guard: each worker tags its broadcasts with a per-process
 *    id and ignores anything tagged with its own id on receive.
 */

const CHANNEL_NAME = 'centralita-client-events';
const BROADCAST_EVENT = 'client_event';
const BROADCAST_TIMEOUT_MS = 2_500;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const WORKER_ID = crypto.randomUUID();
const WORKER_TAG = WORKER_ID.slice(0, 8);

type BroadcastPayload = {
  event: CanonicalClientEvent;
  from_worker: string;
};

type ForwardHandler = (event: CanonicalClientEvent) => void;

type ReceiverBus = {
  channel: RealtimeChannel | null;
  status: 'idle' | 'pending' | 'subscribed' | 'error' | 'closed';
  forward: ForwardHandler | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  receivedCount: number;
  forwardedCount: number;
  droppedSelfCount: number;
};

declare global {
  var __centralitaRealtimeReceiver: ReceiverBus | undefined;
}

function getOrCreateBus(): ReceiverBus {
  if (!globalThis.__centralitaRealtimeReceiver) {
    globalThis.__centralitaRealtimeReceiver = {
      channel: null,
      status: 'idle',
      forward: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      receivedCount: 0,
      forwardedCount: 0,
      droppedSelfCount: 0,
    };
  }
  return globalThis.__centralitaRealtimeReceiver;
}

// ─── Publish (any worker) ───────────────────────────────────────────────────

/**
 * Broadcast a canonical client event to every worker subscribed to the
 * global channel. Uses Supabase's REST broadcast endpoint so a cold-start
 * POST handler doesn't have to wait for a channel subscribe handshake.
 *
 * Bounded by a hard timeout: if Supabase is slow/unresponsive, we give up
 * rather than freezing the Twilio webhook Lambda. Local delivery is
 * already done synchronously by the caller, so cross-worker is a best-effort
 * enhancement — we prefer a dropped cross-worker event over a 30-second
 * Vercel timeout that kills the whole call flow.
 */
export async function broadcastClientEvent(event: CanonicalClientEvent): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[RealtimeBus] Missing SUPABASE env, skipping cross-worker broadcast.');
    return;
  }

  const payload: BroadcastPayload = { event, from_worker: WORKER_ID };
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), BROADCAST_TIMEOUT_MS);

  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: CHANNEL_NAME,
            event: BROADCAST_EVENT,
            payload,
            private: false,
          },
        ],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      console.warn(
        `[RealtimeBus] broadcast REST ${res.status} from worker=${WORKER_TAG} event=${event.type} id=${event.id}: ${body.slice(0, 300)}`,
      );
    } else {
      console.log(
        `[RealtimeBus] → broadcast ok worker=${WORKER_TAG} event=${event.type} id=${event.id} sid=${event.call_sid ?? '-'}`,
      );
    }
  } catch (err) {
    const isAbort = (err as { name?: string } | null)?.name === 'AbortError';
    if (isAbort) {
      console.warn(
        `[RealtimeBus] broadcast REST timeout after ${BROADCAST_TIMEOUT_MS}ms worker=${WORKER_TAG} event=${event.type} id=${event.id}`,
      );
    } else {
      console.warn('[RealtimeBus] broadcast REST error:', err);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Receive (SSE-serving workers) ───────────────────────────────────────────

/**
 * Register the single forwarder that dispatches cross-worker broadcasts into
 * the local in-memory bus. Idempotent — the first call wires the channel;
 * subsequent calls are no-ops (the forwarder is the same module-scoped
 * function across all SSE subscribers).
 *
 * The previous implementation accepted a handler per SSE connection and
 * accumulated them in a Set. Because each SSE caller wrapped the forward
 * in a fresh arrow function, the Set treated them as distinct references
 * and fanned out N² times per cross-worker event. The single-handler
 * pattern avoids that and makes reasoning trivial.
 */
export function ensureCrossWorkerReceiver(forward: ForwardHandler): void {
  const bus = getOrCreateBus();

  if (!bus.forward) {
    bus.forward = forward;
  }

  // Already wired — nothing to do. Channel is held open for the process lifetime.
  if (bus.channel) return;

  connectChannel(bus);
}

function connectChannel(bus: ReceiverBus): void {
  const supabase = createAdminClient();
  const channel = supabase.channel(CHANNEL_NAME);
  bus.channel = channel;
  bus.status = 'pending';

  console.log(
    `[RealtimeBus] Opening channel worker=${WORKER_TAG} topic=${CHANNEL_NAME} attempt=${bus.reconnectAttempts}`,
  );

  channel.on('broadcast', { event: BROADCAST_EVENT }, (message) => {
    bus.receivedCount += 1;
    const raw = message.payload as BroadcastPayload | undefined;
    if (!raw || typeof raw !== 'object') {
      console.warn(`[RealtimeBus] received malformed broadcast worker=${WORKER_TAG}`);
      return;
    }
    if (raw.from_worker === WORKER_ID) {
      bus.droppedSelfCount += 1;
      return; // our own broadcast echoed back
    }
    if (!raw.event) return;

    if (!bus.forward) {
      console.warn(
        `[RealtimeBus] ← received broadcast but no forwarder registered worker=${WORKER_TAG} from=${raw.from_worker?.slice(0, 8)}`,
      );
      return;
    }

    bus.forwardedCount += 1;
    console.log(
      `[RealtimeBus] ← received worker=${WORKER_TAG} from=${raw.from_worker?.slice(0, 8)} event=${raw.event.type} id=${raw.event.id} sid=${raw.event.call_sid ?? '-'}`,
    );

    try {
      bus.forward(raw.event);
    } catch (err) {
      console.warn('[RealtimeBus] forwarder error:', err);
    }
  });

  channel.subscribe((status) => {
    console.log(`[RealtimeBus] channel status worker=${WORKER_TAG} status=${status}`);

    if (status === 'SUBSCRIBED') {
      bus.status = 'subscribed';
      bus.reconnectAttempts = 0;
      return;
    }

    if (status === 'CLOSED') {
      bus.status = 'closed';
      scheduleReconnect(bus);
      return;
    }

    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      bus.status = 'error';
      scheduleReconnect(bus);
    }
  });
}

function scheduleReconnect(bus: ReceiverBus): void {
  if (bus.reconnectTimer) return;

  bus.reconnectAttempts += 1;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, bus.reconnectAttempts - 1),
    RECONNECT_MAX_DELAY_MS,
  );

  console.warn(
    `[RealtimeBus] scheduling reconnect worker=${WORKER_TAG} attempt=${bus.reconnectAttempts} delay=${delay}ms`,
  );

  bus.reconnectTimer = setTimeout(() => {
    bus.reconnectTimer = null;
    const dead = bus.channel;
    bus.channel = null;
    if (dead) {
      try {
        // Best-effort teardown of the dead channel before recreating.
        void dead.unsubscribe();
      } catch {
        // ignore
      }
    }
    connectChannel(bus);
  }, delay);
}

export function getWorkerId(): string {
  return WORKER_ID;
}

/**
 * Diagnostic snapshot — exposed so a debug endpoint can inspect the current
 * receiver state without having to grep logs. Returns null when the bus has
 * never been initialized on this worker.
 */
export function getRealtimeBusStatus(): {
  worker_id: string;
  status: ReceiverBus['status'];
  has_forward: boolean;
  reconnect_attempts: number;
  received_count: number;
  forwarded_count: number;
  dropped_self_count: number;
} | null {
  const bus = globalThis.__centralitaRealtimeReceiver;
  if (!bus) return null;
  return {
    worker_id: WORKER_ID,
    status: bus.status,
    has_forward: !!bus.forward,
    reconnect_attempts: bus.reconnectAttempts,
    received_count: bus.receivedCount,
    forwarded_count: bus.forwardedCount,
    dropped_self_count: bus.droppedSelfCount,
  };
}

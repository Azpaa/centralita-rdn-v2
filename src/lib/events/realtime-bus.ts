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
 *    establish a persistent channel just to send one event.
 *  - Receive: use the Supabase JS client's channel subscription. SSE-serving
 *    Lambdas are long-lived while a client is connected, so a persistent
 *    channel is cheap and reliable there.
 *  - Self-loop guard: each worker tags its broadcasts with a per-process
 *    id and ignores anything tagged with its own id on receive.
 */

const CHANNEL_NAME = 'centralita-client-events';
const BROADCAST_EVENT = 'client_event';

const WORKER_ID = crypto.randomUUID();

type BroadcastPayload = {
  event: CanonicalClientEvent;
  from_worker: string;
};

type ReceiverBus = {
  channel: RealtimeChannel;
  status: 'pending' | 'subscribed' | 'error' | 'closed';
  handlers: Set<(event: CanonicalClientEvent) => void>;
};

declare global {
  var __centralitaRealtimeReceiver: ReceiverBus | undefined;
}

// ─── Publish (any worker) ───────────────────────────────────────────────────

/**
 * Broadcast a canonical client event to every worker subscribed to the
 * global channel. Uses Supabase's REST broadcast endpoint so a cold-start
 * POST handler doesn't have to wait for a channel subscribe handshake.
 *
 * Returns: void promise that resolves once the broadcast HTTP call is
 * accepted. Callers MUST await this before returning the HTTP response —
 * otherwise Vercel may freeze the Lambda before the request completes.
 */
export async function broadcastClientEvent(event: CanonicalClientEvent): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[RealtimeBus] Missing SUPABASE env, skipping cross-worker broadcast.');
    return;
  }

  const payload: BroadcastPayload = { event, from_worker: WORKER_ID };

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
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      console.warn(`[RealtimeBus] broadcast REST ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn('[RealtimeBus] broadcast REST error:', err);
  }
}

// ─── Receive (SSE-serving workers) ───────────────────────────────────────────

/**
 * Register a handler to receive broadcasts from OTHER workers. The first
 * call on this process opens the Realtime channel; subsequent calls just
 * add to the handler set. Channel is held open for the worker lifetime.
 *
 * IMPORTANT: handlers run for events broadcast by OTHER workers only. Events
 * published locally on THIS worker are already delivered via the in-memory
 * bus in `client-stream.ts` — the from_worker guard prevents a double-hit.
 */
export function ensureCrossWorkerReceiver(
  handler: (event: CanonicalClientEvent) => void,
): void {
  const existing = globalThis.__centralitaRealtimeReceiver;
  if (existing) {
    existing.handlers.add(handler);
    return;
  }

  const supabase = createAdminClient();
  const channel = supabase.channel(CHANNEL_NAME);
  const handlers = new Set<(event: CanonicalClientEvent) => void>();
  handlers.add(handler);

  const bus: ReceiverBus = {
    channel,
    status: 'pending',
    handlers,
  };
  globalThis.__centralitaRealtimeReceiver = bus;

  channel.on('broadcast', { event: BROADCAST_EVENT }, (message) => {
    const raw = message.payload as BroadcastPayload | undefined;
    if (!raw || typeof raw !== 'object') return;
    if (raw.from_worker === WORKER_ID) return; // our own broadcast echoed back
    if (!raw.event) return;

    for (const h of bus.handlers) {
      try {
        h(raw.event);
      } catch (err) {
        console.warn('[RealtimeBus] cross-worker handler error:', err);
      }
    }
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      bus.status = 'subscribed';
      console.log(
        `[RealtimeBus] Worker ${WORKER_ID.slice(0, 8)} subscribed to ${CHANNEL_NAME}`,
      );
    } else if (status === 'CLOSED') {
      bus.status = 'closed';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      bus.status = 'error';
      console.warn(`[RealtimeBus] Channel status on worker ${WORKER_ID.slice(0, 8)}: ${status}`);
    }
  });
}

export function getWorkerId(): string {
  return WORKER_ID;
}

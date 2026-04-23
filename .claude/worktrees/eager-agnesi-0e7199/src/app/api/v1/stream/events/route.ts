import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiForbidden } from '@/lib/api/response';
import { resolveAgentRuntimeSnapshot } from '@/lib/calls/agent-state';
import {
  buildCanonicalEventFromStored,
  subscribeCanonicalClientEvents,
  type CanonicalClientEvent,
} from '@/lib/events/client-stream';
import { createAdminClient } from '@/lib/supabase/admin';
import type { EventType } from '@/lib/events/emitter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 25_000;

// Cap replay at a sane ceiling so an agent that reconnects after hours
// doesn't flood their SSE with stale events. Anything older than this
// should come from the snapshot, not from the event log.
const REPLAY_MAX_EVENTS = 100;
const REPLAY_MAX_AGE_MINUTES = 10;

type ConnectedEvent = {
  id: string;
  type: 'connected';
  timestamp: string;
  payload: {
    scope: 'mine' | 'all' | 'agent';
    user_id: string | null;
  };
};

type SnapshotEvent = {
  id: string;
  type: 'snapshot';
  timestamp: string;
  agent_user_id: string | null;
  target_user_ids: string[];
  payload: {
    agent_state: unknown;
  };
};

type HeartbeatEvent = {
  id: string;
  type: 'heartbeat';
  timestamp: string;
  payload: {
    alive: true;
  };
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toSseMessage(payload: unknown, eventId?: string | null): string {
  // Per HTML5 SSE spec: `id:` field updates the browser's Last-Event-ID
  // tracker automatically, so a native EventSource reconnect sends it as
  // a header. We also surface the id in the JSON body for non-EventSource
  // clients (fetch + reader) that read it directly.
  const idLine = eventId ? `id: ${eventId}\n` : '';
  return `${idLine}data: ${JSON.stringify(payload)}\n\n`;
}

type DomainEventRow = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

async function loadReplayEvents(args: {
  targetUserId: string;
  lastEventId: string;
  receiveAll: boolean;
}): Promise<CanonicalClientEvent[]> {
  const supabase = createAdminClient();

  // Resolve the timestamp of the last seen event so we only replay newer
  // ones. If the row is gone (TTL evicted) we fall back to the age cap.
  const { data: anchor } = await supabase
    .from('domain_events')
    .select('created_at')
    .eq('id', args.lastEventId)
    .maybeSingle();

  const cutoffIso = anchor?.created_at
    ?? new Date(Date.now() - REPLAY_MAX_AGE_MINUTES * 60_000).toISOString();

  let query = supabase
    .from('domain_events')
    .select('id, event_type, payload, created_at')
    .gt('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(REPLAY_MAX_EVENTS);

  if (!args.receiveAll) {
    // Events addressed to this user OR where they're the agent. Supabase
    // array ops use `contains` / `cs` — both work with uuid[].
    query = query.or(
      `target_user_ids.cs.{${args.targetUserId}},agent_user_id.eq.${args.targetUserId}`,
    );
  }

  const { data: rows, error } = await query;
  if (error || !rows) return [];

  return (rows as DomainEventRow[]).map((row) =>
    buildCanonicalEventFromStored({
      id: row.id,
      event: row.event_type as EventType,
      data: row.payload,
      timestamp: row.created_at,
    }),
  );
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { searchParams } = new URL(req.url);
  const scopeParam = searchParams.get('scope');
  const requestedUserId = searchParams.get('user_id');
  const clientParam = searchParams.get('client');
  const normalizedClientKind = (
    clientParam
    && /^[a-z0-9._-]{1,64}$/i.test(clientParam)
  )
    ? clientParam.toLowerCase()
    : null;

  let receiveAll = false;
  let targetUserId: string | null = null;
  let scope: ConnectedEvent['payload']['scope'] = 'mine';

  if (auth.authMethod === 'session') {
    if (auth.role === 'admin') {
      if (scopeParam === 'all') {
        receiveAll = true;
        scope = 'all';
      } else if (requestedUserId) {
        if (!isUuid(requestedUserId)) return apiBadRequest('user_id debe ser UUID valido');
        targetUserId = requestedUserId;
        scope = 'agent';
      } else {
        if (!auth.userId) return apiForbidden('No se pudo resolver usuario admin desde sesion');
        targetUserId = auth.userId;
        scope = 'mine';
      }
    } else {
      if (!auth.userId) return apiForbidden('No se pudo resolver usuario operador desde sesion');
      targetUserId = auth.userId;
      scope = 'mine';
    }
  } else {
    // API key M2M: forzar scope explícito para evitar streams globales accidentales.
    if (!requestedUserId) {
      return apiBadRequest('Con API key, user_id es requerido para el stream de eventos');
    }
    if (!isUuid(requestedUserId)) return apiBadRequest('user_id debe ser UUID valido');
    targetUserId = requestedUserId;
    scope = 'agent';
  }

  // Last-Event-ID drives replay. Browsers send it as a header on native
  // EventSource auto-reconnect. Fetch-based clients (Tauri) cannot set
  // arbitrary headers easily in some environments, so we accept a query
  // param fallback.
  const lastEventIdHeader = req.headers.get('last-event-id');
  const lastEventIdParam = searchParams.get('last_event_id');
  const lastEventIdRaw = lastEventIdHeader || lastEventIdParam;
  const lastEventId = lastEventIdRaw && isUuid(lastEventIdRaw) ? lastEventIdRaw : null;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: ConnectedEvent | SnapshotEvent | HeartbeatEvent | CanonicalClientEvent) => {
        if (isClosed) return;
        try {
          const eventId = 'id' in payload && typeof payload.id === 'string' ? payload.id : null;
          controller.enqueue(encoder.encode(toSseMessage(payload, eventId)));
        } catch {
          // Stream already closed by client.
        }
      };

      const close = () => {
        if (isClosed) return;
        isClosed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // no-op
        }
      };

      // Evento de conexión inicial.
      send({
        id: crypto.randomUUID(),
        type: 'connected',
        timestamp: new Date().toISOString(),
        payload: {
          scope,
          user_id: targetUserId,
        },
      });

      // Snapshot inicial canónico del agente (cuando el stream está scoped a agente).
      if (targetUserId) {
        void (async () => {
          try {
            const snapshot = await resolveAgentRuntimeSnapshot(targetUserId as string);
            send({
              id: crypto.randomUUID(),
              type: 'snapshot',
              timestamp: new Date().toISOString(),
              agent_user_id: targetUserId,
              target_user_ids: [targetUserId],
              payload: {
                agent_state: snapshot,
              },
            });

            // Re-ring agent if there are pending ringing calls (reconnect recovery)
            if (snapshot) {
              const ringingCalls = snapshot.active_calls.filter(
                (c) => (c.status === 'ringing' || c.status === 'in_queue')
                  && c.conference_name
                  && !c.answered_by_user_id
              );

              if (ringingCalls.length > 0) {
                const { getTwilioClient } = await import('@/lib/twilio/client');
                const twilioClient = getTwilioClient();
                const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

                for (const call of ringingCalls) {
                  const agentConnectUrl = new URL(`${appBaseUrl}/api/webhooks/twilio/voice/agent-connect`);
                  agentConnectUrl.searchParams.set('conference', call.conference_name!);
                  agentConnectUrl.searchParams.set('call_sid', call.call_sid || '');
                  agentConnectUrl.searchParams.set('operator_id', targetUserId as string);

                  const statusUrl = new URL(`${appBaseUrl}/api/webhooks/twilio/voice/status`);
                  statusUrl.searchParams.set('parent_call_sid', call.call_sid || '');
                  statusUrl.searchParams.set('target_user_id', targetUserId as string);

                  // Use our DID as callerId (for inbound, 'to' is our number)
                  const callerId = call.direction === 'inbound' ? call.to : call.from;

                  twilioClient.calls.create({
                    to: `client:${targetUserId}`,
                    from: callerId,
                    url: agentConnectUrl.toString(),
                    statusCallback: statusUrl.toString(),
                    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                    timeout: 30,
                  }).then((c) => {
                    console.log(`[SSE] Re-ring on reconnect: user=${targetUserId} call_sid=${call.call_sid} new_leg=${c.sid}`);
                  }).catch((err) => {
                    console.warn(`[SSE] Re-ring failed: user=${targetUserId} call_sid=${call.call_sid}: ${(err as Error).message}`);
                  });
                }
                console.log(`[SSE] Triggered re-ring for ${ringingCalls.length} pending call(s) on reconnect`);
              }
            }
          } catch (err) {
            console.error('[SSE] Failed building initial snapshot:', err);
          }
        })();
      }

      // Replay de eventos faltantes desde domain_events cuando el cliente
      // reconecta con Last-Event-ID. Hacemos esto DESPUÉS del snapshot
      // para que el estado base llegue primero y los eventos se apliquen
      // incrementalmente encima. Si no hay Last-Event-ID (conexión fresca)
      // no replicamos nada — el snapshot ya es la verdad.
      if (lastEventId && (targetUserId || receiveAll)) {
        void (async () => {
          try {
            const replayEvents = await loadReplayEvents({
              targetUserId: targetUserId ?? '',
              lastEventId,
              receiveAll,
            });
            for (const evt of replayEvents) {
              send(evt);
            }
            if (replayEvents.length > 0) {
              console.log(
                `[SSE] Replayed ${replayEvents.length} event(s) for user=${targetUserId ?? 'all'} since id=${lastEventId}`,
              );
            }
          } catch (err) {
            console.error('[SSE] Replay failed:', err);
          }
        })();
      }

      // Suscripción al bus canónico backend -> clientes.
      unsubscribe = subscribeCanonicalClientEvents({
        receiveAll,
        targetUserId,
        clientKind: normalizedClientKind,
        onEvent: (event) => send(event),
      });

      // Keepalive para evitar cierre silencioso en proxies.
      heartbeatTimer = setInterval(() => {
        send({
          id: crypto.randomUUID(),
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
          payload: { alive: true },
        });
      }, HEARTBEAT_MS);

      req.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

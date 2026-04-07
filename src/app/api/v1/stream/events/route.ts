import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiForbidden } from '@/lib/api/response';
import { resolveAgentRuntimeSnapshot } from '@/lib/calls/agent-state';
import {
  subscribeCanonicalClientEvents,
  type CanonicalClientEvent,
} from '@/lib/events/client-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 25_000;

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

function toSseMessage(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { searchParams } = new URL(req.url);
  const scopeParam = searchParams.get('scope');
  const requestedUserId = searchParams.get('user_id');

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

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: ConnectedEvent | SnapshotEvent | HeartbeatEvent | CanonicalClientEvent) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(toSseMessage(payload)));
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
          } catch (err) {
            console.error('[SSE] Failed building initial snapshot:', err);
          }
        })();
      }

      // Suscripción al bus canónico backend -> clientes.
      unsubscribe = subscribeCanonicalClientEvents({
        receiveAll,
        targetUserId,
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

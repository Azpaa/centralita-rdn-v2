import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess } from '@/lib/api/response';
import { getRealtimeBusStatus, getWorkerId } from '@/lib/events/realtime-bus';

/**
 * GET /api/v1/debug/realtime
 *
 * Diagnostic endpoint for the cross-worker Supabase Realtime bridge.
 *
 * Returns the in-memory state of __centralitaRealtimeReceiver for the
 * Lambda that happens to serve this request. Because each Lambda has its
 * own copy, you often need to hit this endpoint several times to get a
 * picture of the fleet — Vercel will round-robin across workers.
 *
 * Status values:
 *  - idle: bus never initialized (no SSE subscriber has been on this worker)
 *  - pending: channel.subscribe() called but not yet acknowledged
 *  - subscribed: healthy
 *  - closed / error: reconnect in progress
 *
 * If you see forwarded_count staying at 0 while other workers are
 * publishing, the channel is deaf — likely a Supabase Realtime misconfig
 * or a dropped WebSocket with failed reconnects.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  return apiSuccess({
    worker_id: getWorkerId(),
    bus: getRealtimeBusStatus(),
    timestamp: new Date().toISOString(),
  });
}

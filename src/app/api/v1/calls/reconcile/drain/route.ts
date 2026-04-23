import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiForbidden, apiSuccess } from '@/lib/api/response';
import { drainReconcileOutbox } from '@/lib/events/reconcile-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/calls/reconcile/drain
 *
 * Drains `reconcile_event_outbox` rows that the Supabase edge reconcile
 * function left behind. Exposed as a first-class endpoint so a lightweight
 * cron (or health probe, or admin action) can poke it explicitly without
 * having to trigger a full reconcile run.
 *
 * Safe to call concurrently — the drainer coalesces overlapping calls
 * into a single in-flight operation, so a flurry of polls degenerates to
 * one round-trip.
 *
 * Access: admin session OR any API key (RDN's worker process will use this).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  if (auth.authMethod === 'session' && auth.role !== 'admin') {
    return apiForbidden('Solo admin puede drenar el outbox manualmente');
  }

  const result = await drainReconcileOutbox();
  return apiSuccess(result);
}

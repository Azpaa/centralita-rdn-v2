import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest } from '@/lib/api/response';
import { processPendingWebhookDeliveries } from '@/lib/events/delivery';
import { z } from 'zod';

const retrySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * POST /api/v1/webhooks/retry-deliveries
 * Procesa entregas webhook pendientes cuyo `next_retry_at` ya vencio.
 *
 * Recomendado ejecutar por cron cada 1 minuto para reintentos persistentes.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // body vacio -> usar defaults
  }

  const parsed = retrySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  const result = await processPendingWebhookDeliveries(parsed.data.limit ?? 100);
  return apiSuccess({
    ...result,
    processed_at: new Date().toISOString(),
  });
}

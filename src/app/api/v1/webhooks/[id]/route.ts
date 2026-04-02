import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiNoContent, apiInternalError } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).optional(),
  description: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

/**
 * GET /api/v1/webhooks/:id — Detalle de suscripción webhook
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, events, active, description, failure_count, last_success_at, last_failure_at, created_at, updated_at')
    .eq('id', id)
    .single();

  if (error || !data) return apiNotFound('Suscripción webhook');

  // Obtener últimas 10 entregas
  const { data: deliveries } = await supabase
    .from('webhook_delivery_log')
    .select('id, event_type, response_status, delivered, attempts, created_at')
    .eq('subscription_id', id)
    .order('created_at', { ascending: false })
    .limit(10);

  return apiSuccess({
    ...data,
    recent_deliveries: deliveries || [],
  });
}

/**
 * PUT /api/v1/webhooks/:id — Actualizar suscripción webhook
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = updateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .update(parsed.data)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) return apiNotFound('Suscripción webhook');

  return apiSuccess(data);
}

/**
 * DELETE /api/v1/webhooks/:id — Eliminar suscripción webhook
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase
    .from('webhook_subscriptions')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting webhook:', error);
    return apiInternalError();
  }

  await auditLog('api_key.deleted', 'webhook_subscription', id, auth.userId);

  return apiNoContent();
}

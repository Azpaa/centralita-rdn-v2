import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiNoContent, apiInternalError, apiConflict } from '@/lib/api/response';
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

const VALID_EVENT_PATTERNS = [
  '*',
  'call.*', 'call.incoming', 'call.ringing', 'call.answered', 'call.completed',
  'call.missed', 'call.transferred', 'call.hold', 'call.resumed',
  'agent.*', 'agent.online', 'agent.offline', 'agent.available', 'agent.unavailable', 'agent.busy',
  'recording.*', 'recording.ready',
];

function isLikelyEphemeralOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '0.0.0.0'
    || host.endsWith('.local')
    || host.endsWith('.localhost')
    || host.endsWith('.ngrok.io')
    || host.endsWith('.ngrok-free.app')
    || host.endsWith('.trycloudflare.com')
  );
}

function isWebhookDevUrlAllowed(): boolean {
  return process.env.WEBHOOK_ALLOW_DEV_URLS === 'true' || process.env.NODE_ENV !== 'production';
}

function validateWebhookTargetUrl(rawUrl: string): { ok: true } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, message: 'URL invalida' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, message: 'La URL del webhook debe usar HTTPS' };
  }

  if (!isWebhookDevUrlAllowed() && isLikelyEphemeralOrLocalHost(parsed.hostname)) {
    return {
      ok: false,
      message: 'URL de webhook bloqueada en produccion: usa un dominio estable (no localhost/ngrok/tunnel temporal)',
    };
  }

  return { ok: true };
}

function normalizeWebhookUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

function normalizeEventPatterns(events: string[]): string[] {
  return [...new Set(events.map((e) => e.trim()).filter(Boolean))].sort();
}

/**
 * GET /api/v1/webhooks/:id - Detalle de suscripcion webhook
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

  if (error || !data) return apiNotFound('Suscripcion webhook');

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
 * PUT /api/v1/webhooks/:id - Actualizar suscripcion webhook
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
    return apiBadRequest('Body JSON invalido');
  }

  const parsed = updateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  if (parsed.data.events) {
    const invalidEvents = parsed.data.events.filter((e) => !VALID_EVENT_PATTERNS.includes(e));
    if (invalidEvents.length > 0) {
      return apiBadRequest(
        `Eventos invalidos: ${invalidEvents.join(', ')}. Eventos validos: ${VALID_EVENT_PATTERNS.join(', ')}`
      );
    }
  }

  const supabase = createAdminClient();

  const { data: current } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, active')
    .eq('id', id)
    .single();
  if (!current) return apiNotFound('Suscripcion webhook');

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (typeof parsed.data.url === 'string') {
    const targetValidation = validateWebhookTargetUrl(parsed.data.url);
    if (!targetValidation.ok) {
      return apiBadRequest(targetValidation.message);
    }
    updateData.url = normalizeWebhookUrl(parsed.data.url);
  }
  if (Array.isArray(parsed.data.events)) {
    const normalizedEvents = normalizeEventPatterns(parsed.data.events);
    if (normalizedEvents.length === 0) {
      return apiBadRequest('Debe especificar al menos un evento válido');
    }
    updateData.events = normalizedEvents;
  }

  const nextUrl = typeof updateData.url === 'string' ? updateData.url : current.url;
  const nextActive = typeof updateData.active === 'boolean' ? updateData.active : current.active;

  if (nextActive) {
    const { data: duplicateActive } = await supabase
      .from('webhook_subscriptions')
      .select('id')
      .eq('active', true)
      .eq('url', nextUrl)
      .neq('id', id)
      .limit(1);

    if (duplicateActive && duplicateActive.length > 0) {
      return apiConflict(
        `Ya existe otra suscripcion webhook activa para la URL ${nextUrl}.`
      );
    }
  }

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) return apiNotFound('Suscripcion webhook');

  return apiSuccess(data);
}

/**
 * DELETE /api/v1/webhooks/:id - Eliminar suscripcion webhook
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

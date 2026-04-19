import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import {
  apiSuccess,
  apiCreated,
  apiBadRequest,
  apiConflict,
  apiInternalError,
  parsePagination,
  buildMeta,
} from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';
import type { WebhookSubscription } from '@/lib/types/database';
import { z } from 'zod';

// --- Validación ---

const createWebhookSchema = z.object({
  url: z.string().url('URL debe ser válida (https://...)'),
  events: z.array(z.string().min(1)).min(1, 'Debe especificar al menos un evento'),
  description: z.string().optional().nullable(),
});

// --- Eventos válidos ---
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
 * GET /api/v1/webhooks — Listar suscripciones webhook
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  const { data, error, count } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, events, active, description, failure_count, last_success_at, last_failure_at, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(skip, skip + limit - 1);

  if (error) {
    console.error('Error listing webhooks:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

/**
 * POST /api/v1/webhooks — Crear suscripción webhook
 *
 * Genera automáticamente un secret para firmar payloads.
 * Devuelve el secret UNA SOLA VEZ en la respuesta de creación.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  // Validar que los eventos sean válidos
  const invalidEvents = parsed.data.events.filter(e => !VALID_EVENT_PATTERNS.includes(e));
  if (invalidEvents.length > 0) {
    return apiBadRequest(`Eventos inválidos: ${invalidEvents.join(', ')}. Eventos válidos: ${VALID_EVENT_PATTERNS.join(', ')}`);
  }

  const targetValidation = validateWebhookTargetUrl(parsed.data.url);
  if (!targetValidation.ok) {
    return apiBadRequest(targetValidation.message);
  }

  const normalizedUrl = normalizeWebhookUrl(parsed.data.url);
  const normalizedEvents = normalizeEventPatterns(parsed.data.events);
  if (normalizedEvents.length === 0) {
    return apiBadRequest('Debe especificar al menos un evento válido');
  }

  const supabase = createAdminClient();

  const { data: existingActive } = await supabase
    .from('webhook_subscriptions')
    .select('id, url')
    .eq('active', true)
    .eq('url', normalizedUrl)
    .limit(1);

  if (existingActive && existingActive.length > 0) {
    return apiConflict(
      `Ya existe una suscripcion webhook activa para esta URL (${normalizedUrl}). Desactiva o elimina la anterior antes de crear otra.`
    );
  }

  // Generar secret criptográficamente seguro
  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .insert({
      url: normalizedUrl,
      secret,
      events: normalizedEvents,
      active: true,
      description: parsed.data.description ?? null,
      api_key_id: auth.apiKeyId ?? null,
    })
    .select()
    .single<WebhookSubscription>();

  if (error) {
    console.error('Error creating webhook:', error);
    return apiInternalError();
  }

  await auditLog('api_key.created', 'webhook_subscription', data.id, auth.userId, {
    url: normalizedUrl,
    events: normalizedEvents,
  });

  // Devolver incluyendo el secret (solo esta vez)
  return apiCreated({
    ...data,
    secret, // ⚠️ Solo se muestra al crear
  });
}

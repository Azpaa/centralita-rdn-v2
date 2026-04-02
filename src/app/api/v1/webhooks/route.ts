import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import {
  apiSuccess,
  apiCreated,
  apiBadRequest,
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

  // Generar secret criptográficamente seguro
  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .insert({
      url: parsed.data.url,
      secret,
      events: parsed.data.events,
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
    url: parsed.data.url,
    events: parsed.data.events,
  });

  // Devolver incluyendo el secret (solo esta vez)
  return apiCreated({
    ...data,
    secret, // ⚠️ Solo se muestra al crear
  });
}

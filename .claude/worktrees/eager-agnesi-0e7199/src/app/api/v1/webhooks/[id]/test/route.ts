import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiNotFound } from '@/lib/api/response';
import type { WebhookSubscription } from '@/lib/types/database';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/webhooks/:id/test — Enviar evento de prueba
 *
 * Envía un evento `test.ping` al endpoint del webhook para verificar
 * que la URL es accesible y la firma se puede validar.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: sub, error } = await supabase
    .from('webhook_subscriptions')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !sub) return apiNotFound('Suscripción webhook');

  const subscription = sub as WebhookSubscription;
  const eventId = crypto.randomUUID();

  const payload = {
    event_id: eventId,
    event: 'test.ping',
    timestamp: new Date().toISOString(),
    data: {
      message: 'Este es un evento de prueba de la Centralita RDN',
      subscription_id: id,
    },
  };

  const bodyStr = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', subscription.secret)
    .update(bodyStr)
    .digest('hex');

  const deliveryId = crypto.randomUUID();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Centralita-Signature': `sha256=${signature}`,
        'X-Centralita-Event': 'test.ping',
        'X-Centralita-Event-Id': eventId,
        'X-Centralita-Delivery-Id': deliveryId,
        'X-Centralita-Timestamp': payload.timestamp,
        'User-Agent': 'Centralita-RDN/2.0',
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text().catch(() => '');

    return apiSuccess({
      test: true,
      event_id: eventId,
      delivery_id: deliveryId,
      url: subscription.url,
      response_status: response.status,
      response_body: responseBody.slice(0, 500),
      success: response.status >= 200 && response.status < 300,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return apiSuccess({
      test: true,
      event_id: eventId,
      delivery_id: deliveryId,
      url: subscription.url,
      response_status: null,
      error: message,
      success: false,
    });
  }
}

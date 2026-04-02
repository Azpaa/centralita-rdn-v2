/**
 * Sistema de eventos — Entrega de webhooks.
 *
 * Envía el payload firmado con HMAC-SHA256 al endpoint de la suscripción.
 * Implementa retry con backoff exponencial.
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { WebhookSubscription } from '@/lib/types/database';
import type { EventPayload } from '@/lib/events/emitter';

/** Intervalos de retry en segundos: 10s, 60s, 300s */
const RETRY_DELAYS = [10, 60, 300];

/** Timeout para cada intento de entrega */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Entrega un webhook a una suscripción.
 * Registra el intento en webhook_delivery_log.
 * Si falla y hay reintentos disponibles, programa el siguiente.
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: EventPayload,
): Promise<void> {
  const supabase = createAdminClient();
  const deliveryId = crypto.randomUUID();
  const bodyStr = JSON.stringify(payload);

  // Firmar el payload con HMAC-SHA256
  const signature = crypto
    .createHmac('sha256', subscription.secret)
    .update(bodyStr)
    .digest('hex');

  // Crear registro de delivery
  await supabase.from('webhook_delivery_log').insert({
    id: deliveryId,
    subscription_id: subscription.id,
    event_type: payload.event,
    payload: payload as unknown as Record<string, unknown>,
    attempts: 1,
    max_attempts: RETRY_DELAYS.length + 1,
  });

  // Intentar entregar
  const result = await attemptDelivery(subscription.url, bodyStr, signature, payload, deliveryId);

  if (result.success) {
    // Marcar como entregado
    await supabase
      .from('webhook_delivery_log')
      .update({
        delivered: true,
        response_status: result.status,
        response_body: result.body?.slice(0, 1000) ?? null,
      })
      .eq('id', deliveryId);

    // Actualizar suscripción: reset failure count
    await supabase
      .from('webhook_subscriptions')
      .update({
        failure_count: 0,
        last_success_at: new Date().toISOString(),
      })
      .eq('id', subscription.id);
  } else {
    // Falló — programar retry si quedan intentos
    const nextRetryIndex = 0; // primer retry
    const nextRetryAt = new Date(Date.now() + RETRY_DELAYS[nextRetryIndex] * 1000);

    await supabase
      .from('webhook_delivery_log')
      .update({
        response_status: result.status ?? null,
        response_body: result.body?.slice(0, 1000) ?? null,
        error_message: result.error?.slice(0, 500) ?? null,
        next_retry_at: nextRetryAt.toISOString(),
      })
      .eq('id', deliveryId);

    // Incrementar failure count
    await supabase
      .from('webhook_subscriptions')
      .update({
        failure_count: (subscription.failure_count || 0) + 1,
        last_failure_at: new Date().toISOString(),
      })
      .eq('id', subscription.id);

    // Auto-desactivar si demasiados fallos consecutivos (>50)
    if ((subscription.failure_count || 0) + 1 >= 50) {
      console.warn(`[DELIVERY] Disabling subscription ${subscription.id} — too many failures`);
      await supabase
        .from('webhook_subscriptions')
        .update({ active: false })
        .eq('id', subscription.id);
    }

    // Programar retry en background
    scheduleRetry(deliveryId, subscription, payload, 1);
  }
}

/**
 * Programa un reintento con delay.
 */
function scheduleRetry(
  deliveryId: string,
  subscription: WebhookSubscription,
  payload: EventPayload,
  attempt: number,
): void {
  if (attempt > RETRY_DELAYS.length) return; // No más reintentos

  const delayMs = RETRY_DELAYS[attempt - 1] * 1000;

  setTimeout(async () => {
    try {
      const bodyStr = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', subscription.secret)
        .update(bodyStr)
        .digest('hex');

      const result = await attemptDelivery(subscription.url, bodyStr, signature, payload, deliveryId);
      const supabase = createAdminClient();

      if (result.success) {
        await supabase
          .from('webhook_delivery_log')
          .update({
            delivered: true,
            attempts: attempt + 1,
            response_status: result.status,
            response_body: result.body?.slice(0, 1000) ?? null,
            error_message: null,
            next_retry_at: null,
          })
          .eq('id', deliveryId);

        await supabase
          .from('webhook_subscriptions')
          .update({
            failure_count: 0,
            last_success_at: new Date().toISOString(),
          })
          .eq('id', subscription.id);
      } else {
        const nextAttempt = attempt + 1;
        const nextRetryAt = nextAttempt <= RETRY_DELAYS.length
          ? new Date(Date.now() + RETRY_DELAYS[nextAttempt - 1] * 1000)
          : null;

        await supabase
          .from('webhook_delivery_log')
          .update({
            attempts: attempt + 1,
            response_status: result.status ?? null,
            response_body: result.body?.slice(0, 1000) ?? null,
            error_message: result.error?.slice(0, 500) ?? null,
            next_retry_at: nextRetryAt?.toISOString() ?? null,
          })
          .eq('id', deliveryId);

        // Continuar reintentando
        scheduleRetry(deliveryId, subscription, payload, nextAttempt);
      }
    } catch (err) {
      console.error(`[DELIVERY] Retry ${attempt} error for ${deliveryId}:`, err);
    }
  }, delayMs);
}

/**
 * Intenta entregar el webhook.
 */
async function attemptDelivery(
  url: string,
  bodyStr: string,
  signature: string,
  payload: EventPayload,
  deliveryId: string,
): Promise<{ success: boolean; status?: number; body?: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Centralita-Signature': `sha256=${signature}`,
        'X-Centralita-Event': payload.event,
        'X-Centralita-Delivery-Id': deliveryId,
        'X-Centralita-Timestamp': payload.timestamp,
        'User-Agent': 'Centralita-RDN/2.0',
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text().catch(() => '');

    // 2xx = éxito
    if (response.status >= 200 && response.status < 300) {
      return { success: true, status: response.status, body: responseBody };
    }

    return {
      success: false,
      status: response.status,
      body: responseBody,
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

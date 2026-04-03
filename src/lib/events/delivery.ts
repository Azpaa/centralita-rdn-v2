/**
 * Sistema de eventos - Entrega de webhooks.
 *
 * Este módulo mantiene el estado de delivery en DB (persistente) y procesa
 * reintentos con backoff usando `next_retry_at`.
 *
 * Garantías:
 * - At-least-once delivery
 * - Delivery ID estable por suscripción+evento (mismo ID en retries)
 * - Reintentos persistidos (no se pierden por reinicio)
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { WebhookSubscription } from '@/lib/types/database';
import type { EventPayload } from '@/lib/events/emitter';

/** Intervalos de retry en segundos: 10s, 60s, 300s */
const RETRY_DELAYS = [10, 60, 300];

/** Timeout para cada intento de entrega */
const DELIVERY_TIMEOUT_MS = 10_000;

type PendingDeliveryRow = {
  id: string;
  subscription_id: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  delivered: boolean;
  next_retry_at: string | null;
};

export type RetryProcessingResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

/**
 * Entrega inicial de un webhook.
 * Si falla, deja el retry programado en DB (`next_retry_at`).
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: EventPayload,
): Promise<void> {
  const supabase = createAdminClient();
  const deliveryId = crypto.randomUUID();
  const maxAttempts = RETRY_DELAYS.length + 1;

  const normalizedPayload = ensureEventId(payload);

  const { error: insertError } = await supabase.from('webhook_delivery_log').insert({
    id: deliveryId,
    subscription_id: subscription.id,
    event_type: normalizedPayload.event,
    payload: normalizedPayload as unknown as Record<string, unknown>,
    attempts: 0,
    max_attempts: maxAttempts,
    delivered: false,
    next_retry_at: null,
  });

  if (insertError) {
    console.error('[DELIVERY] Error creating delivery row:', insertError);
    return;
  }

  await runDeliveryAttempt({
    deliveryId,
    subscription,
    payload: normalizedPayload,
    currentAttempts: 0,
    maxAttempts,
  });
}

/**
 * Procesa deliveries pendientes ya vencidos (`next_retry_at <= now`).
 * Pensado para ejecutarse por cron o de forma oportunista.
 */
export async function processPendingWebhookDeliveries(limit = 100): Promise<RetryProcessingResult> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const result: RetryProcessingResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  const { data, error } = await supabase
    .from('webhook_delivery_log')
    .select('id, subscription_id, payload, attempts, max_attempts, delivered, next_retry_at')
    .eq('delivered', false)
    .not('next_retry_at', 'is', null)
    .lte('next_retry_at', now)
    .order('next_retry_at', { ascending: true })
    .limit(limit);

  if (error || !data || data.length === 0) {
    return result;
  }

  const pending = data as PendingDeliveryRow[];
  const subscriptionIds = [...new Set(pending.map((row) => row.subscription_id))];

  const { data: subsData } = await supabase
    .from('webhook_subscriptions')
    .select('*')
    .in('id', subscriptionIds)
    .eq('active', true);

  const subscriptions = (subsData || []) as WebhookSubscription[];
  const subMap = new Map(subscriptions.map((sub) => [sub.id, sub]));

  for (const row of pending) {
    if (row.attempts >= row.max_attempts) {
      result.skipped += 1;
      continue;
    }

    const sub = subMap.get(row.subscription_id);
    if (!sub) {
      await supabase
        .from('webhook_delivery_log')
        .update({
          error_message: 'Subscription not found or inactive',
          next_retry_at: null,
        })
        .eq('id', row.id);
      result.skipped += 1;
      continue;
    }

    const payload = normalizePersistedPayload(row.payload);
    if (!payload) {
      await supabase
        .from('webhook_delivery_log')
        .update({
          attempts: row.max_attempts,
          error_message: 'Invalid payload format',
          next_retry_at: null,
        })
        .eq('id', row.id);
      result.skipped += 1;
      continue;
    }

    // Persistir event_id si no existía en payload antiguo.
    if (isMissingEventId(row.payload)) {
      await supabase
        .from('webhook_delivery_log')
        .update({ payload: payload as unknown as Record<string, unknown> })
        .eq('id', row.id);
    }

    const success = await runDeliveryAttempt({
      deliveryId: row.id,
      subscription: sub,
      payload,
      currentAttempts: row.attempts,
      maxAttempts: row.max_attempts,
    });

    result.processed += 1;
    if (success) result.succeeded += 1;
    else result.failed += 1;
  }

  return result;
}

async function runDeliveryAttempt(params: {
  deliveryId: string;
  subscription: WebhookSubscription;
  payload: EventPayload;
  currentAttempts: number;
  maxAttempts: number;
}): Promise<boolean> {
  const { deliveryId, subscription, payload, currentAttempts, maxAttempts } = params;
  const supabase = createAdminClient();
  const bodyStr = JSON.stringify(payload);

  // Firmar payload con HMAC-SHA256
  const signature = crypto
    .createHmac('sha256', subscription.secret)
    .update(bodyStr)
    .digest('hex');

  const attemptNumber = currentAttempts + 1;
  const result = await attemptDelivery(subscription.url, bodyStr, signature, payload, deliveryId);

  if (result.success) {
    await supabase
      .from('webhook_delivery_log')
      .update({
        delivered: true,
        attempts: attemptNumber,
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

    subscription.failure_count = 0;
    return true;
  }

  const nextRetryAt = computeNextRetryAt(attemptNumber, maxAttempts);

  await supabase
    .from('webhook_delivery_log')
    .update({
      attempts: attemptNumber,
      response_status: result.status ?? null,
      response_body: result.body?.slice(0, 1000) ?? null,
      error_message: result.error?.slice(0, 500) ?? null,
      next_retry_at: nextRetryAt,
    })
    .eq('id', deliveryId);

  const nextFailureCount = (subscription.failure_count || 0) + 1;

  await supabase
    .from('webhook_subscriptions')
    .update({
      failure_count: nextFailureCount,
      last_failure_at: new Date().toISOString(),
    })
    .eq('id', subscription.id);

  subscription.failure_count = nextFailureCount;

  if (nextFailureCount >= 50) {
    console.warn(`[DELIVERY] Disabling subscription ${subscription.id} - too many failures`);
    await supabase
      .from('webhook_subscriptions')
      .update({ active: false })
      .eq('id', subscription.id);
  }

  return false;
}

function computeNextRetryAt(attemptNumber: number, maxAttempts: number): string | null {
  if (attemptNumber >= maxAttempts) return null;
  const delaySeconds = RETRY_DELAYS[attemptNumber - 1];
  if (!delaySeconds) return null;
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

function ensureEventId(payload: EventPayload): EventPayload {
  if (payload.event_id) return payload;
  return {
    ...payload,
    event_id: crypto.randomUUID(),
  };
}

function isMissingEventId(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const value = (payload as Record<string, unknown>).event_id;
  return typeof value !== 'string' || value.length === 0;
}

function normalizePersistedPayload(payload: unknown): EventPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;

  const event = typeof raw.event === 'string' ? raw.event : null;
  if (!event) return null;

  const timestamp = typeof raw.timestamp === 'string'
    ? raw.timestamp
    : new Date().toISOString();

  const data = raw.data && typeof raw.data === 'object'
    ? (raw.data as Record<string, unknown>)
    : {};

  const eventId = typeof raw.event_id === 'string' && raw.event_id.length > 0
    ? raw.event_id
    : crypto.randomUUID();

  return {
    event: event as EventPayload['event'],
    timestamp,
    data,
    event_id: eventId,
  };
}

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
        'X-Centralita-Event-Id': payload.event_id,
        'X-Centralita-Delivery-Id': deliveryId,
        'X-Centralita-Timestamp': payload.timestamp,
        'User-Agent': 'Centralita-RDN/2.0',
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text().catch(() => '');

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

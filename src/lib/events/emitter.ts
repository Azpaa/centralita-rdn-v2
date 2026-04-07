/**
 * Sistema de eventos - Motor de emision.
 *
 * emitEvent() es la funcion principal para emitir eventos hacia RDN.
 * Es fire-and-forget: nunca bloquea ni lanza errores al caller.
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { deliverWebhook, processPendingWebhookDeliveries } from '@/lib/events/delivery';
import { publishCanonicalClientEventFromDomain } from '@/lib/events/client-stream';
import type { WebhookSubscription } from '@/lib/types/database';

export type EventType =
  | 'call.incoming'
  | 'call.ringing'
  | 'call.answered'
  | 'call.completed'
  | 'call.missed'
  | 'call.transferred'
  | 'call.hold'
  | 'call.resumed'
  | 'agent.online'
  | 'agent.offline'
  | 'agent.available'
  | 'agent.unavailable'
  | 'agent.busy'
  | 'recording.ready';

export interface EventPayload {
  event_id: string;
  event: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export async function emitEvent(
  event: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
      console.error(`[EVENT] Skipping ${event}: payload.data vacio o invalido`);
      return;
    }

    // Canal canónico backend -> clientes (web / futuro Tauri).
    // Debe publicarse siempre, incluso cuando no haya webhooks externos activos.
    publishCanonicalClientEventFromDomain(event, data);

    processPendingWebhookDeliveries().catch((err) => {
      console.error('[EVENT] Error processing pending deliveries:', err);
    });

    const supabase = createAdminClient();

    const { data: subscriptions, error } = await supabase
      .from('webhook_subscriptions')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error || !subscriptions || subscriptions.length === 0) return;

    const payload: EventPayload = {
      event_id: crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const matching = (subscriptions as WebhookSubscription[]).filter((sub) =>
      matchesEventPattern(sub.events, event)
    );

    if (matching.length === 0) return;

    // Proteccion operativa: si hay varias activas para la misma URL,
    // enviamos solo a la mas reciente para evitar firmas inconsistentes.
    const dedupByUrl = new Map<string, WebhookSubscription>();
    for (const sub of matching) {
      const key = normalizeWebhookUrlForDelivery(sub.url);
      const existing = dedupByUrl.get(key);
      if (existing) {
        console.warn(
          `[EVENT] Duplicate active webhook URL detected (${key}). Keeping ${existing.id}, skipping ${sub.id}`
        );
        continue;
      }
      dedupByUrl.set(key, sub);
    }

    const targets = [...dedupByUrl.values()];
    if (targets.length === 0) return;

    const deliveries = targets.map((sub) =>
      deliverWebhook(sub, payload).catch((err) => {
        console.error(`[EVENT] Error delivering ${event} to ${sub.url}:`, err);
      })
    );

    Promise.allSettled(deliveries).catch(() => {});
  } catch (err) {
    console.error(`[EVENT] Error emitting ${event}:`, err);
  }
}

function matchesEventPattern(patterns: string[], event: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern === event) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      return event.startsWith(prefix);
    }
    return false;
  });
}

function normalizeWebhookUrlForDelivery(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    const pathname = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${pathname}${u.search}`;
  } catch {
    return rawUrl.trim();
  }
}

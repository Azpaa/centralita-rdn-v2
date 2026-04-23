/**
 * Sistema de eventos - Motor de emision.
 *
 * emitEvent() es la funcion principal para emitir eventos hacia RDN.
 * Es fire-and-forget: nunca bloquea ni lanza errores al caller.
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { deliverWebhook, processPendingWebhookDeliveries } from '@/lib/events/delivery';
import {
  extractStreamTargetsFromDomainEvent,
  publishCanonicalClientEventFromDomain,
} from '@/lib/events/client-stream';
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
  | 'recording.ready'
  | 'webhook.subscription_disabled';

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

    // Persist the event in domain_events BEFORE publishing downstream so
    // every consumer (SSE, webhook delivery) shares the same event_id.
    // That unified id is what enables:
    //   - client-side dedup by id (Tauri)
    //   - Last-Event-ID replay on SSE reconnect
    //   - webhook idempotency on RDN side
    // We still want emit to be fire-and-forget semantics from the
    // caller's perspective, but we do await the INSERT so the id exists
    // by the time we publish to SSE.
    const supabase = createAdminClient();
    const timestamp = new Date().toISOString();
    const callSidCandidate = typeof data.call_sid === 'string' && data.call_sid.length > 0
      ? data.call_sid
      : typeof data.twilio_call_sid === 'string' && data.twilio_call_sid.length > 0
        ? data.twilio_call_sid
        : null;
    const callRecordIdCandidate = typeof data.call_record_id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.call_record_id)
      ? data.call_record_id
      : null;
    const { agentUserId, targetUserIds } = extractStreamTargetsFromDomainEvent(data);

    let eventId: string = crypto.randomUUID();
    try {
      const { data: inserted } = await supabase
        .from('domain_events')
        .insert({
          id: eventId,
          event_type: event,
          payload: data,
          agent_user_id: agentUserId,
          target_user_ids: targetUserIds,
          call_sid: callSidCandidate,
          call_record_id: callRecordIdCandidate,
          created_at: timestamp,
        })
        .select('id')
        .single();

      if (inserted?.id) eventId = inserted.id;
    } catch (err) {
      // Non-fatal: if the log insert fails, we still publish downstream with the
      // locally-generated id. The cost is that SSE reconnect replay will miss
      // this event, but the call can still progress.
      console.warn(`[EVENT] Failed persisting ${event} to domain_events; falling back to in-memory id:`, err);
    }

    // Canal canónico backend -> clientes (web / futuro Tauri).
    // Debe publicarse siempre, incluso cuando no haya webhooks externos activos.
    // Await is required so the Supabase Realtime broadcast completes before
    // this Lambda returns — otherwise Vercel may freeze us mid-broadcast
    // and cross-worker subscribers never receive the event.
    await publishCanonicalClientEventFromDomain(event, data, { eventId, timestamp });

    processPendingWebhookDeliveries().catch((err) => {
      console.error('[EVENT] Error processing pending deliveries:', err);
    });

    const { data: subscriptions, error } = await supabase
      .from('webhook_subscriptions')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error || !subscriptions || subscriptions.length === 0) return;

    const payload: EventPayload = {
      event_id: eventId,
      event,
      timestamp,
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

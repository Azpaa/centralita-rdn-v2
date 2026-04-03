/**
 * Sistema de eventos — Motor de emisión.
 *
 * emitEvent() es la función principal que todo el sistema usa para emitir
 * eventos hacia RDN. Es fire-and-forget: nunca bloquea ni lanza errores.
 *
 * Flujo:
 * 1. emitEvent('call.answered', { ... })
 * 2. Busca todas las suscripciones activas que coincidan con el evento
 * 3. Para cada suscripción, llama a deliverWebhook()
 * 4. Si falla, programa reintentos (máx 3)
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { deliverWebhook, processPendingWebhookDeliveries } from '@/lib/events/delivery';
import type { WebhookSubscription } from '@/lib/types/database';

/**
 * Tipos de eventos soportados.
 */
export type EventType =
  // Llamadas
  | 'call.incoming'
  | 'call.ringing'
  | 'call.answered'
  | 'call.completed'
  | 'call.missed'
  | 'call.transferred'
  | 'call.hold'
  | 'call.resumed'
  // Agentes
  | 'agent.online'
  | 'agent.offline'
  | 'agent.available'
  | 'agent.unavailable'
  | 'agent.busy'
  // Grabaciones
  | 'recording.ready';

/**
 * Payload base de un evento.
 */
export interface EventPayload {
  event_id: string;
  event: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Emitir un evento hacia todas las suscripciones que coincidan.
 * Fire-and-forget: nunca bloquea ni lanza errores al caller.
 */
export async function emitEvent(
  event: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    // Reintentos pendientes persistidos (best effort, no bloquea la emisión actual).
    processPendingWebhookDeliveries().catch((err) => {
      console.error('[EVENT] Error processing pending deliveries:', err);
    });

    const supabase = createAdminClient();

    // Buscar suscripciones activas que escuchen este evento
    const { data: subscriptions, error } = await supabase
      .from('webhook_subscriptions')
      .select('*')
      .eq('active', true);

    if (error || !subscriptions || subscriptions.length === 0) return;

    const payload: EventPayload = {
      event_id: crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    // Filtrar suscripciones por patrón de eventos
    const matching = (subscriptions as WebhookSubscription[]).filter(sub =>
      matchesEventPattern(sub.events, event)
    );

    if (matching.length === 0) return;

    // Entregar a cada suscripción en paralelo (fire-and-forget)
    const deliveries = matching.map(sub =>
      deliverWebhook(sub, payload).catch(err => {
        console.error(`[EVENT] Error delivering ${event} to ${sub.url}:`, err);
      })
    );

    // No esperamos — es fire-and-forget. Pero usamos Promise.allSettled
    // para que no se pierdan los errores si el proceso sigue vivo.
    Promise.allSettled(deliveries).catch(() => {});
  } catch (err) {
    console.error(`[EVENT] Error emitting ${event}:`, err);
  }
}

/**
 * Comprueba si un evento coincide con los patrones de una suscripción.
 *
 * Patrones soportados:
 * - 'call.answered' → coincide exactamente
 * - 'call.*' → coincide con cualquier evento que empiece por 'call.'
 * - '*' → coincide con todo
 */
function matchesEventPattern(patterns: string[], event: string): boolean {
  return patterns.some(pattern => {
    if (pattern === '*') return true;
    if (pattern === event) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // 'call.*' → 'call.'
      return event.startsWith(prefix);
    }
    return false;
  });
}

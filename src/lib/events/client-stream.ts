import crypto from 'crypto';
import type { EventType } from '@/lib/events/emitter';
import { broadcastClientEvent, ensureCrossWorkerReceiver } from './realtime-bus';

export type CanonicalClientEventType =
  | 'connected'
  | 'snapshot'
  | 'incoming_call'
  | 'call_answered'
  | 'call_updated'
  | 'call_ended'
  | 'call_transfer_started'
  | 'call_transfer_completed'
  | 'conference_updated'
  | 'agent_state_changed'
  | 'recording_ready'
  | 'heartbeat';

export type CanonicalClientEvent = {
  id: string;
  type: CanonicalClientEventType;
  timestamp: string;
  domain_event?: EventType;
  call_sid?: string | null;
  call_record_id?: string | null;
  direction?: string | null;
  status?: string | null;
  agent_user_id?: string | null;
  target_user_ids?: string[];
  payload: Record<string, unknown>;
};

type StreamSubscriber = {
  id: string;
  receiveAll: boolean;
  targetUserId: string | null;
  clientKind: string | null;
  onEvent: (event: CanonicalClientEvent) => void;
};

type StreamBusState = {
  subscribers: Map<string, StreamSubscriber>;
};

declare global {
  var __centralitaClientStreamBus: StreamBusState | undefined;
}

function getBusState(): StreamBusState {
  if (!globalThis.__centralitaClientStreamBus) {
    globalThis.__centralitaClientStreamBus = {
      subscribers: new Map<string, StreamSubscriber>(),
    };
  }
  return globalThis.__centralitaClientStreamBus;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function getString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getStringArray(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function extractAgentUserId(data: Record<string, unknown>): string | null {
  const candidateKeys = [
    'answered_by_user_id',
    'user_id',
    'resolved_agent_id',
    'operator_id',
    'by_user_id',
  ];

  for (const key of candidateKeys) {
    const value = data[key];
    if (isUuid(value)) return value;
  }

  return null;
}

function extractTargetUserIds(data: Record<string, unknown>, agentUserId: string | null): string[] {
  const userIds = new Set<string>();

  if (agentUserId) userIds.add(agentUserId);

  const directKeys = [
    'user_id',
    'answered_by_user_id',
    'resolved_agent_id',
    'operator_id',
    'by_user_id',
  ];

  for (const key of directKeys) {
    const value = data[key];
    if (isUuid(value)) userIds.add(value);
  }

  for (const candidate of getStringArray(data, 'candidate_user_ids')) {
    if (isUuid(candidate)) userIds.add(candidate);
  }

  return [...userIds];
}

function mapDomainEventType(event: EventType): CanonicalClientEventType {
  switch (event) {
    case 'call.incoming':
    case 'call.ringing':
      return 'incoming_call';
    case 'call.answered':
      return 'call_answered';
    case 'call.completed':
    case 'call.missed':
      return 'call_ended';
    case 'call.hold':
    case 'call.resumed':
      return 'call_updated';
    case 'call.transferred':
      return 'call_transfer_completed';
    case 'recording.ready':
      return 'recording_ready';
    case 'agent.online':
    case 'agent.offline':
    case 'agent.available':
    case 'agent.unavailable':
    case 'agent.busy':
      return 'agent_state_changed';
    default:
      return 'call_updated';
  }
}

function buildCanonicalEvent(
  event: EventType,
  data: Record<string, unknown>,
  options?: { eventId?: string; timestamp?: string },
): CanonicalClientEvent {
  const agentUserId = extractAgentUserId(data);
  const targetUserIds = extractTargetUserIds(data, agentUserId);

  return {
    id: options?.eventId ?? crypto.randomUUID(),
    type: mapDomainEventType(event),
    timestamp: options?.timestamp ?? new Date().toISOString(),
    domain_event: event,
    call_sid: getString(data, 'call_sid') ?? getString(data, 'twilio_call_sid'),
    call_record_id: getString(data, 'call_record_id'),
    direction: getString(data, 'direction'),
    status: getString(data, 'status') ?? getString(data, 'final_status'),
    agent_user_id: agentUserId,
    target_user_ids: targetUserIds,
    payload: data,
  };
}

// Exported for domain_events replay path — given a persisted row, rebuild
// the canonical SSE event preserving the stored event id so client-side
// dedup by id stays consistent across reconnects.
export function buildCanonicalEventFromStored(args: {
  id: string;
  event: EventType;
  data: Record<string, unknown>;
  timestamp: string;
}): CanonicalClientEvent {
  return buildCanonicalEvent(args.event, args.data, {
    eventId: args.id,
    timestamp: args.timestamp,
  });
}

export function extractStreamTargetsFromDomainEvent(data: Record<string, unknown>): {
  agentUserId: string | null;
  targetUserIds: string[];
} {
  const agentUserId = extractAgentUserId(data);
  const targetUserIds = extractTargetUserIds(data, agentUserId);
  return { agentUserId, targetUserIds };
}

function shouldDeliverToSubscriber(subscriber: StreamSubscriber, event: CanonicalClientEvent): boolean {
  if (subscriber.receiveAll) return true;
  if (!subscriber.targetUserId) return false;

  if (event.agent_user_id && event.agent_user_id === subscriber.targetUserId) return true;
  if (event.target_user_ids?.includes(subscriber.targetUserId)) return true;

  return false;
}

function publishToLocalSubscribers(event: CanonicalClientEvent): void {
  const bus = getBusState();
  if (bus.subscribers.size === 0) {
    console.log(
      `[SSE] no local subscribers event=${event.type} id=${event.id} sid=${event.call_sid ?? '-'}`,
    );
    return;
  }

  let delivered = 0;
  for (const subscriber of bus.subscribers.values()) {
    if (!shouldDeliverToSubscriber(subscriber, event)) continue;

    try {
      subscriber.onEvent(event);
      delivered += 1;
    } catch (err) {
      console.warn(`[SSE] Failed delivering canonical event to subscriber ${subscriber.id}:`, err);
    }
  }

  if (delivered === 0) {
    console.log(
      `[SSE] no matching subscriber event=${event.type} id=${event.id} sid=${event.call_sid ?? '-'} total_subs=${bus.subscribers.size} agent=${event.agent_user_id ?? '-'} targets=[${(event.target_user_ids ?? []).join(',')}]`,
    );
  } else {
    console.log(
      `[SSE] delivered event=${event.type} id=${event.id} sid=${event.call_sid ?? '-'} to=${delivered}/${bus.subscribers.size}`,
    );
  }
}

// Module-scoped forwarder so `ensureCrossWorkerReceiver` registers a SINGLE
// stable function reference across all SSE subscribers. The old code passed
// a fresh arrow function per subscribe call, which meant the receiver
// couldn't dedupe and cross-worker events were fanned out multiple times
// (or, worse, held references to closures of long-gone streams).
function forwardCrossWorkerEvent(remoteEvent: CanonicalClientEvent): void {
  publishToLocalSubscribers(remoteEvent);
}

/**
 * Publish a canonical client event.
 *
 * Two-stage fanout:
 *  1. Deliver synchronously to same-worker SSE subscribers via the in-memory
 *     bus. This is the common case and the fast path.
 *  2. Broadcast the event via Supabase Realtime so OTHER workers can deliver
 *     it to subscribers held on their side. This exists because Vercel
 *     serverless runs each request on whatever Lambda is warm — the SSE is
 *     on one, the control POST is often on another.
 *
 * IMPORTANT: this is async. Callers inside API route handlers MUST await it
 * before returning the HTTP response, otherwise Vercel may freeze the Lambda
 * mid-broadcast and the event never reaches remote workers.
 */
export async function publishCanonicalClientEvent(event: CanonicalClientEvent): Promise<void> {
  publishToLocalSubscribers(event);
  await broadcastClientEvent(event);
}

/**
 * Synchronous variant for call sites that cannot await (legacy emitter
 * paths). Fires broadcast as a background task; on Vercel this only
 * reliably completes if the surrounding handler stays alive long enough.
 * Prefer `publishCanonicalClientEvent` in new code.
 */
export function publishCanonicalClientEventSync(event: CanonicalClientEvent): void {
  publishToLocalSubscribers(event);
  void broadcastClientEvent(event).catch((err) => {
    console.warn('[SSE] Background broadcast failed:', err);
  });
}

export async function publishCanonicalClientEventFromDomain(
  event: EventType,
  data: Record<string, unknown>,
  options?: { eventId?: string; timestamp?: string },
): Promise<void> {
  try {
    const canonical = buildCanonicalEvent(event, data, options);
    await publishCanonicalClientEvent(canonical);
  } catch (err) {
    console.error(`[SSE] Error mapping domain event ${event} to canonical stream event:`, err);
  }
}

export function subscribeCanonicalClientEvents(params: {
  receiveAll: boolean;
  targetUserId: string | null;
  clientKind?: string | null;
  onEvent: (event: CanonicalClientEvent) => void;
}): () => void {
  // Opening an SSE stream means this worker is now serving a client. Make
  // sure we're also wired to receive broadcasts from OTHER workers so
  // events published on those workers still reach this subscriber. The
  // receiver is a per-process singleton — passing the SAME forwarder
  // reference every time is what makes its idempotency actually work.
  ensureCrossWorkerReceiver(forwardCrossWorkerEvent);

  const bus = getBusState();
  const subscriber: StreamSubscriber = {
    id: crypto.randomUUID(),
    receiveAll: params.receiveAll,
    targetUserId: params.targetUserId,
    clientKind: params.clientKind ?? null,
    onEvent: params.onEvent,
  };

  bus.subscribers.set(subscriber.id, subscriber);
  console.log(
    `[SSE] subscriber added id=${subscriber.id} user=${params.targetUserId ?? '-'} kind=${params.clientKind ?? '-'} receiveAll=${params.receiveAll} total_subs=${bus.subscribers.size}`,
  );

  return () => {
    bus.subscribers.delete(subscriber.id);
    console.log(
      `[SSE] subscriber removed id=${subscriber.id} user=${params.targetUserId ?? '-'} remaining=${bus.subscribers.size}`,
    );
  };
}

const DESKTOP_CLIENT_KINDS = new Set([
  'voice_agent_desktop',
  'tauri_voice_agent',
  'tauri_desktop',
]);

function isDesktopClientKind(clientKind: string | null): boolean {
  if (!clientKind) return false;
  return DESKTOP_CLIENT_KINDS.has(clientKind.toLowerCase());
}

export function hasActiveDesktopStreamForUser(userId: string): boolean {
  const bus = getBusState();
  for (const subscriber of bus.subscribers.values()) {
    if (subscriber.targetUserId !== userId) continue;
    if (!isDesktopClientKind(subscriber.clientKind)) continue;
    return true;
  }
  return false;
}

/**
 * Any SSE client (desktop Tauri OR browser dashboard OR admin receiveAll)
 * subscribed for this user. Used by control endpoints (accept/reject/dial)
 * to decide if issuing a command is pointless — if nobody is listening,
 * there's nothing to execute and the endpoint should report that back
 * instead of queueing a silent ghost command.
 */
export function hasActiveStreamForUser(userId: string): boolean {
  const bus = getBusState();
  for (const subscriber of bus.subscribers.values()) {
    if (subscriber.receiveAll) continue; // admin-all doesn't count as "the agent is listening"
    if (subscriber.targetUserId !== userId) continue;
    return true;
  }
  return false;
}

/**
 * Pick which surface should execute a command for this user.
 *
 * Rules:
 * - If desktop (Tauri) is present, desktop wins — it's the stable
 *   always-on softphone. Browser ignores.
 * - If only browser is present, browser executes.
 * - If nothing is present, return null — caller should 409 the request
 *   instead of emitting a silent command.
 */
export type PreferredExecutor = 'desktop' | 'browser';

export function pickPreferredExecutorForUser(userId: string): PreferredExecutor | null {
  const bus = getBusState();
  let sawBrowser = false;
  for (const subscriber of bus.subscribers.values()) {
    if (subscriber.receiveAll) continue;
    if (subscriber.targetUserId !== userId) continue;
    if (isDesktopClientKind(subscriber.clientKind)) return 'desktop';
    sawBrowser = true;
  }
  return sawBrowser ? 'browser' : null;
}

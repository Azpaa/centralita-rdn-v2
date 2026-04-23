import crypto from 'crypto';
import type { EventType } from '@/lib/events/emitter';

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

function buildCanonicalEvent(event: EventType, data: Record<string, unknown>): CanonicalClientEvent {
  const agentUserId = extractAgentUserId(data);
  const targetUserIds = extractTargetUserIds(data, agentUserId);

  return {
    id: crypto.randomUUID(),
    type: mapDomainEventType(event),
    timestamp: new Date().toISOString(),
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

function shouldDeliverToSubscriber(subscriber: StreamSubscriber, event: CanonicalClientEvent): boolean {
  if (subscriber.receiveAll) return true;
  if (!subscriber.targetUserId) return false;

  if (event.agent_user_id && event.agent_user_id === subscriber.targetUserId) return true;
  if (event.target_user_ids?.includes(subscriber.targetUserId)) return true;

  return false;
}

export function publishCanonicalClientEvent(event: CanonicalClientEvent): void {
  const bus = getBusState();
  if (bus.subscribers.size === 0) return;

  for (const subscriber of bus.subscribers.values()) {
    if (!shouldDeliverToSubscriber(subscriber, event)) continue;

    try {
      subscriber.onEvent(event);
    } catch (err) {
      console.warn(`[SSE] Failed delivering canonical event to subscriber ${subscriber.id}:`, err);
    }
  }
}

export function publishCanonicalClientEventFromDomain(
  event: EventType,
  data: Record<string, unknown>,
): void {
  try {
    const canonical = buildCanonicalEvent(event, data);
    publishCanonicalClientEvent(canonical);
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
  const bus = getBusState();
  const subscriber: StreamSubscriber = {
    id: crypto.randomUUID(),
    receiveAll: params.receiveAll,
    targetUserId: params.targetUserId,
    clientKind: params.clientKind ?? null,
    onEvent: params.onEvent,
  };

  bus.subscribers.set(subscriber.id, subscriber);

  return () => {
    bus.subscribers.delete(subscriber.id);
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

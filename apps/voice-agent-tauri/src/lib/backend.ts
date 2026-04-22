import type {
  AgentStateSnapshot,
  BootstrapPayload,
  CallRecordLookup,
  CanonicalStreamEvent,
  VoiceTokenPayload,
} from './types';

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

type ApiSuccess<T> = { ok: true; data: T };
type ApiError = { ok: false; error: string };
export type ApiResult<T> = ApiSuccess<T> | ApiError;

async function requestJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string } | string;
    };

    if (!res.ok) {
      const message = typeof body.error === 'string'
        ? body.error
        : body.error?.message || `HTTP ${res.status}`;
      return { ok: false, error: message };
    }

    return { ok: true, data: body.data as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network_error' };
  }
}

export async function fetchBootstrap(baseUrl: string): Promise<ApiResult<BootstrapPayload>> {
  return requestJson<BootstrapPayload>(`${baseUrl}/api/v1/voice-agent/bootstrap`);
}

export async function fetchAgentState(baseUrl: string, jwt: string): Promise<ApiResult<AgentStateSnapshot>> {
  return requestJson<AgentStateSnapshot>(`${baseUrl}/api/v1/agent/me/state`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
  });
}

export async function fetchVoiceToken(baseUrl: string, jwt: string): Promise<ApiResult<VoiceTokenPayload>> {
  return requestJson<VoiceTokenPayload>(`${baseUrl}/api/v1/token`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
  });
}

export async function fetchCallByTwilioSid(
  baseUrl: string,
  jwt: string,
  twilioCallSid: string,
): Promise<ApiResult<CallRecordLookup | null>> {
  const params = new URLSearchParams({
    twilio_call_sid: twilioCallSid,
    page: '1',
    limit: '1',
  });

  const result = await requestJson<CallRecordLookup[]>(`${baseUrl}/api/v1/calls?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!result.ok) return result;
  return { ok: true, data: result.data[0] ?? null };
}

export async function callCommand(
  baseUrl: string,
  jwt: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<ApiResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

export async function updateUserAvailability(
  baseUrl: string,
  jwt: string,
  userId: string,
  available: boolean,
): Promise<ApiResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(`${baseUrl}/api/v1/users/${userId}/availability`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ available }),
  });
}

function parseEventData(raw: string): CanonicalStreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as CanonicalStreamEvent;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function consumeSseStream(params: {
  baseUrl: string;
  jwt: string;
  onEvent: (event: CanonicalStreamEvent) => void;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
  signal: AbortSignal;
  // Last canonical event id successfully applied before a prior
  // disconnect. The backend replays persisted domain_events with a newer
  // id so we don't miss transitions that happened mid-drop.
  lastEventId?: string | null;
}): Promise<void> {
  const { baseUrl, jwt, onEvent, onStatus, signal, lastEventId } = params;
  onStatus('connecting');

  const streamUrl = new URL(`${baseUrl}/api/v1/stream/events`);
  streamUrl.searchParams.set('scope', 'mine');
  streamUrl.searchParams.set('client', 'voice_agent_desktop');
  if (lastEventId) {
    streamUrl.searchParams.set('last_event_id', lastEventId);
  }

  const response = await fetch(streamUrl.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'text/event-stream',
      // Native EventSource header; we mirror it so the server sees the
      // same signal whether it's a browser EventSource or a fetch reader.
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`stream_http_${response.status}`);
  }

  onStatus('connected');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const lines = frame.split('\n');
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data:\s?/, ''));

      if (dataLines.length === 0) continue;

      const event = parseEventData(dataLines.join('\n'));
      if (!event) continue;
      onEvent(event);
    }
  }

  onStatus('disconnected');
}

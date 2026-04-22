import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import {
  type ApiResult,
  callCommand,
  consumeSseStream,
  fetchAgentState,
  fetchBootstrap,
  normalizeBaseUrl,
  updateUserAvailability,
} from './lib/backend';
import type {
  AgentStateSnapshot,
  BootstrapPayload,
  CanonicalStreamEvent,
  VoiceCallView,
  VoiceDeviceStatus,
} from './lib/types';
import { useVoiceEngine } from './lib/voice-engine';
import incomingRingUrl from './assets/incoming-ring.wav';

const DEFAULT_BACKEND_URL = 'https://centralita.reparacionesdelnorte.es';
const BOOTSTRAP_BACKEND_URL = normalizeBaseUrl(
  import.meta.env.VITE_VOICE_AGENT_BACKEND_URL
    || import.meta.env.VITE_BACKEND_URL
    || DEFAULT_BACKEND_URL
);
const STORAGE_SESSION_KEY = 'voice-agent-tauri-auth';
const SESSION_REFRESH_INTERVAL_MS = 45_000;
const SESSION_REFRESH_SKEW_SECONDS = 120;
const STREAM_STALE_TIMEOUT_MS = 85_000;
const STREAM_WATCHDOG_INTERVAL_MS = 12_000;
const WAKE_GAP_DETECT_MS = 15_000;
const WAKE_GAP_THRESHOLD_MS = 55_000;
const RECOVERY_RECONNECT_THROTTLE_MS = 3_000;
const REMOTE_ACCEPT_RETRY_DELAY_MS = 350;
const REMOTE_ACCEPT_MAX_ATTEMPTS = 5;
const REMOTE_COMMAND_TTL_MS = 10 * 60_000;
const REMOTE_COMMAND_MAX_TRACKED = 200;
const FALLBACK_RING_BEEP_INTERVAL_MS = 3000;
const FALLBACK_RING_BEEP_DURATION_MS = 1200;
const FALLBACK_RING_BEEP_FREQ_A_HZ = 440;
const FALLBACK_RING_BEEP_FREQ_B_HZ = 480;

type StreamStatus = 'connecting' | 'connected' | 'disconnected';

function operationalLabel(status: AgentStateSnapshot['operational_status'] | 'unknown'): string {
  switch (status) {
    case 'busy_in_call':
      return 'En llamada';
    case 'ringing':
      return 'Entrante';
    case 'ready':
      return 'Listo';
    case 'unavailable':
      return 'No disponible';
    case 'inactive':
      return 'Inactivo';
    default:
      return 'Sin estado';
  }
}

function voiceStatusLabel(status: VoiceDeviceStatus): string {
  switch (status) {
    case 'connected':
      return 'Conectado';
    case 'registering':
      return 'Registrando';
    case 'reconnecting':
      return 'Reconectando';
    case 'degraded':
      return 'Degradado';
    case 'disconnected':
    default:
      return 'Desconectado';
  }
}

function voiceStatusClass(status: VoiceDeviceStatus): string {
  switch (status) {
    case 'connected':
      return 'status-pill status-ok';
    case 'registering':
    case 'reconnecting':
      return 'status-pill status-warn';
    case 'degraded':
      return 'status-pill status-danger';
    case 'disconnected':
    default:
      return 'status-pill status-neutral';
  }
}

function upsertCall(list: VoiceCallView[], next: VoiceCallView): VoiceCallView[] {
  const index = list.findIndex((item) => item.callSid === next.callSid);
  if (index === -1) return [...list, next];

  const updated = [...list];
  updated[index] = {
    ...updated[index],
    ...next,
  };
  return updated;
}

function isJwtOrAuthError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('jwt')
    || normalized.includes('unauthorized')
    || normalized.includes('no valido')
    || normalized.includes('sesion')
    || normalized.includes('session')
    || normalized.includes('401')
  );
}

function isTransientNetworkError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('network')
    || normalized.includes('fetch')
    || normalized.includes('offline')
    || normalized.includes('timeout')
    || normalized.includes('aborted')
  );
}

function getSessionToken(session: Session | null): string {
  return session?.access_token || '';
}

export default function App() {
  const backendUrl = BOOTSTRAP_BACKEND_URL;
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [agentState, setAgentState] = useState<AgentStateSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('disconnected');
  const [calls, setCalls] = useState<VoiceCallView[]>([]);
  const [conferenceName, setConferenceName] = useState('');
  // Map of callSid → conference name for incoming calls (from SSE events)
  const [incomingConferences, setIncomingConferences] = useState<Map<string, string>>(new Map());
  const [lastEvent, setLastEvent] = useState('none');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const authSubscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);
  const accessTokenRef = useRef(accessToken);
  const sseControllerRef = useRef<AbortController | null>(null);
  const processedRemoteCommandIdsRef = useRef<Map<string, number>>(new Map());
  const remoteAcceptInFlightRef = useRef<Set<string>>(new Set());
  const lastStreamEventAtRef = useRef<number>(Date.now());
  const lastWakeTickRef = useRef<number>(Date.now());
  const availabilitySyncInFlightRef = useRef(false);
  const lastSyncedAvailabilityRef = useRef<boolean | null>(null);
  const reconnectVoiceRef = useRef<() => Promise<void>>(async () => {});
  const lastRecoveryTriggerAtRef = useRef<number>(0);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneRef = useRef<{
    context: AudioContext | null;
    interval: ReturnType<typeof setInterval> | null;
    active: boolean;
  }>({
    context: null,
    interval: null,
    active: false,
  });

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  const applySnapshot = useCallback((snapshot: AgentStateSnapshot | null) => {
    setAgentState(snapshot);
    if (!snapshot) {
      setCalls([]);
      return;
    }

    setCalls((prev) => {
      const mutedBySid = new Map(prev.map((call) => [call.callSid, call.muted]));
      return snapshot.active_calls
        .filter((call) => typeof call.call_sid === 'string' && call.call_sid.length > 0)
        .map((call) => ({
          callSid: call.call_sid as string,
          direction: call.direction,
          status: call.status,
          from: call.from || null,
          to: call.to || null,
          muted: mutedBySid.get(call.call_sid as string) ?? false,
        }));
    });

    // Ensure ringing inbound calls have a known conference so Accept works
    // even after reconnection (when the original SSE event was missed).
    setIncomingConferences((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const call of snapshot.active_calls) {
        if (
          call.direction === 'inbound'
          && call.status === 'ringing'
          && typeof call.call_sid === 'string'
          && call.call_sid.length > 0
          && !next.has(call.call_sid)
        ) {
          next.set(call.call_sid, `call-${call.call_sid}`);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const ensureFreshSession = useCallback(async (
    reason: string,
    options?: {
      forceRefresh?: boolean;
      silent?: boolean;
    },
  ): Promise<string> => {
    const supabase = supabaseRef.current;
    if (!supabase) return '';

    const forceRefresh = Boolean(options?.forceRefresh);
    const silent = Boolean(options?.silent);

    const sessionResult = await supabase.auth.getSession();
    if (sessionResult.error) {
      if (!silent) {
        setMessage(`No se pudo leer sesion (${reason}): ${sessionResult.error.message}`);
      }
      return '';
    }

    let session = sessionResult.data.session;
    const token = getSessionToken(session);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = session?.expires_at ?? 0;
    const isNearExpiry = expiresAt > 0 && expiresAt - now <= SESSION_REFRESH_SKEW_SECONDS;

    if (forceRefresh || !token || isNearExpiry) {
      const refreshResult = await supabase.auth.refreshSession();
      if (refreshResult.error || !refreshResult.data.session) {
        const refreshError = refreshResult.error?.message || 'sin session';
        const authFailure = isJwtOrAuthError(refreshError) && !isTransientNetworkError(refreshError);
        if (!silent) {
          setMessage(
            authFailure
              ? `Sesion no valida (${reason}): ${refreshError}`
              : `No se pudo refrescar sesion (${reason}): ${refreshError}. Reintentando en segundo plano.`
          );
        }
        if (authFailure) {
          setAccessToken('');
          return '';
        }
        return token || accessTokenRef.current;
      }
      session = refreshResult.data.session;
    }

    const freshToken = getSessionToken(session);
    if (freshToken && freshToken !== accessTokenRef.current) {
      setAccessToken(freshToken);
    }

    return freshToken;
  }, []);

  const withJwtRetry = useCallback(async <T,>(
    reason: string,
    request: (jwt: string) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> => {
    const token = await ensureFreshSession(`${reason}:initial`, { silent: true });
    if (!token) {
      return { ok: false, error: 'Sesion no valida' };
    }

    let result = await request(token);
    if (!result.ok && isJwtOrAuthError(result.error)) {
      const refreshed = await ensureFreshSession(`${reason}:retry`, {
        forceRefresh: true,
        silent: true,
      });
      if (!refreshed) return result;
      result = await request(refreshed);
    }
    return result;
  }, [ensureFreshSession]);

  const syncAvailability = useCallback(async (
    nextAvailable: boolean,
    reason: string,
  ) => {
    if (!backendUrl || !accessTokenRef.current) return;
    const userId = agentState?.user_id;
    const backendAvailability = agentState?.available;
    if (!userId) return;
    if (availabilitySyncInFlightRef.current) return;
    const backendAlreadySynced = backendAvailability === nextAvailable;
    if (lastSyncedAvailabilityRef.current === nextAvailable && backendAlreadySynced) return;

    availabilitySyncInFlightRef.current = true;
    try {
      const result = await withJwtRetry(
        `availability:${reason}`,
        (jwt) => updateUserAvailability(backendUrl, jwt, userId, nextAvailable),
      );

      if (result.ok) {
        lastSyncedAvailabilityRef.current = nextAvailable;
      } else {
        setMessage(`No se pudo sincronizar disponibilidad: ${result.error}`);
      }
    } finally {
      availabilitySyncInFlightRef.current = false;
    }
  }, [agentState?.available, agentState?.user_id, backendUrl, withJwtRetry]);

  const refreshAgentSnapshot = useCallback(async (reason: string) => {
    if (!backendUrl || !accessTokenRef.current) return;

    const result = await withJwtRetry(
      `agent_state:${reason}`,
      (jwt) => fetchAgentState(backendUrl, jwt),
    );
    if (!result.ok) {
      setMessage(`No se pudo refrescar estado (${reason}): ${result.error}`);
      return;
    }
    applySnapshot(result.data);
  }, [applySnapshot, backendUrl, withJwtRetry]);

  const handleVoiceCallStarted = useCallback((callSid: string, direction: 'inbound' | 'outbound', destination: string | null) => {
    setCalls((prev) => upsertCall(prev, {
      callSid,
      direction,
      status: 'in_progress',
      from: null,
      to: destination,
      muted: false,
    }));
  }, []);

  const handleVoiceAccepted = useCallback((callSid: string) => {
    setCalls((prev) => prev.map((call) => (
      call.callSid === callSid
        ? { ...call, status: 'in_progress' }
        : call
    )));
  }, []);

  const handleVoiceEnded = useCallback((callSid: string) => {
    setCalls((prev) => prev.filter((call) => call.callSid !== callSid));
  }, []);

  const handleVoiceMutedChanged = useCallback((callSid: string, muted: boolean) => {
    setCalls((prev) => prev.map((call) => (
      call.callSid === callSid
        ? { ...call, muted }
        : call
    )));
  }, []);

  const handleVoiceInfo = useCallback((info: string) => {
    setMessage(info);
  }, []);

  useEffect(() => {
    const audio = new Audio(incomingRingUrl);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0.8;
    ringtoneAudioRef.current = audio;

    return () => {
      audio.pause();
      audio.src = '';
      ringtoneAudioRef.current = null;
    };
  }, []);

  const stopIncomingRingtone = useCallback(() => {
    const state = ringtoneRef.current;
    state.active = false;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    const audio = ringtoneAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, []);

  const primeIncomingRingtone = useCallback(async () => {
    const audio = ringtoneAudioRef.current;
    if (audio) {
      try {
        audio.muted = true;
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
      } catch {
        // Ignore autoplay warmup errors.
      } finally {
        audio.muted = false;
      }
    }

    const context = ringtoneRef.current.context;
    if (context && context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        // Best-effort warmup.
      }
    }
  }, []);

  const startIncomingRingtone = useCallback(async () => {
    const state = ringtoneRef.current;
    if (state.active) return;
    state.active = true;

    const audio = ringtoneAudioRef.current;
    if (audio) {
      try {
        audio.currentTime = 0;
        await audio.play();
        return;
      } catch {
        // Fallback to generated tone.
      }
    }

    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
      state.active = false;
      return;
    }

    if (!state.context) {
      state.context = new window.AudioContext();
    }

    const context = state.context;
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        state.active = false;
        return;
      }
    }

    const playBeep = () => {
      if (!state.active) return;
      if (context.state === 'closed') return;

      const oscA = context.createOscillator();
      const oscB = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      const durationSec = FALLBACK_RING_BEEP_DURATION_MS / 1000;

      oscA.type = 'sine';
      oscA.frequency.setValueAtTime(FALLBACK_RING_BEEP_FREQ_A_HZ, now);
      oscB.type = 'sine';
      oscB.frequency.setValueAtTime(FALLBACK_RING_BEEP_FREQ_B_HZ, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

      oscA.connect(gain);
      oscB.connect(gain);
      gain.connect(context.destination);

      oscA.start(now);
      oscB.start(now);
      oscA.stop(now + durationSec + 0.02);
      oscB.stop(now + durationSec + 0.02);
    };

    playBeep();
    state.interval = setInterval(playBeep, FALLBACK_RING_BEEP_INTERVAL_MS);
  }, []);

  const voice = useVoiceEngine({
    baseUrl: backendUrl,
    accessToken,
    onCallStarted: handleVoiceCallStarted,
    onCallAccepted: handleVoiceAccepted,
    onCallEnded: handleVoiceEnded,
    onCallMutedChanged: handleVoiceMutedChanged,
    onInfo: handleVoiceInfo,
  });

  useEffect(() => {
    reconnectVoiceRef.current = voice.reconnectNow;
  }, [voice.reconnectNow]);

  useEffect(() => {
    const unlockAudio = () => {
      void primeIncomingRingtone();
    };

    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [primeIncomingRingtone]);

  useEffect(() => {
    if (!accessToken || !agentState?.user_id) return;

    const shouldBeAvailable =
      voice.deviceStatus === 'connected'
      || voice.deviceStatus === 'registering'
      || voice.deviceStatus === 'reconnecting';

    void syncAvailability(shouldBeAvailable, `voice:${voice.deviceStatus}`);
  }, [accessToken, agentState?.user_id, syncAvailability, voice.deviceStatus]);

  useEffect(() => {
    if (!accessToken || !agentState?.user_id) return;
    const shouldBeAvailable =
      voice.deviceStatus === 'connected'
      || voice.deviceStatus === 'registering'
      || voice.deviceStatus === 'reconnecting';
    if (!shouldBeAvailable) return;

    const interval = setInterval(() => {
      void syncAvailability(true, 'desktop_presence_keepalive');
    }, 20_000);

    return () => {
      clearInterval(interval);
    };
  }, [accessToken, agentState?.user_id, syncAvailability, voice.deviceStatus]);

  useEffect(() => {
    if (accessToken) return;
    lastSyncedAvailabilityRef.current = null;
    availabilitySyncInFlightRef.current = false;
  }, [accessToken]);

  const wasRemoteCommandProcessed = useCallback((commandId: string): boolean => {
    const now = Date.now();
    const tracked = processedRemoteCommandIdsRef.current;

    for (const [knownId, timestamp] of tracked.entries()) {
      if (now - timestamp > REMOTE_COMMAND_TTL_MS) {
        tracked.delete(knownId);
      }
    }

    return tracked.has(commandId);
  }, []);

  const markRemoteCommandProcessed = useCallback((commandId: string) => {
    const tracked = processedRemoteCommandIdsRef.current;
    tracked.set(commandId, Date.now());

    if (tracked.size <= REMOTE_COMMAND_MAX_TRACKED) return;

    const ordered = [...tracked.entries()].sort((a, b) => a[1] - b[1]);
    const overflow = ordered.length - REMOTE_COMMAND_MAX_TRACKED;
    for (let index = 0; index < overflow; index += 1) {
      tracked.delete(ordered[index][0]);
    }
  }, []);

  const executeRemoteAccept = useCallback(async (callSid: string, commandId: string | null) => {
    if (commandId && wasRemoteCommandProcessed(commandId)) return;
    if (remoteAcceptInFlightRef.current.has(callSid)) return;

    remoteAcceptInFlightRef.current.add(callSid);
    try {
      // For incoming calls, join the conference room
      const confName = incomingConferences.get(callSid) || `call-${callSid}`;
      const result = await voice.joinConference({
        conferenceName: confName,
        parentCallSid: callSid,
      });

      if (result.ok) {
        if (commandId) markRemoteCommandProcessed(commandId);
        setMessage(`Orden remota ejecutada: unido a conferencia para llamada ${callSid}.`);
      } else {
        setMessage(`No se pudo unir a conferencia para ${callSid}: ${result.error}`);
      }
    } finally {
      remoteAcceptInFlightRef.current.delete(callSid);
    }
  }, [incomingConferences, markRemoteCommandProcessed, voice, wasRemoteCommandProcessed]);

  // Track outbound connect requests we've already processed
  const processedOutboundRequestsRef = useRef<Set<string>>(new Set());

  const handleCanonicalEvent = useCallback((event: CanonicalStreamEvent) => {
    lastStreamEventAtRef.current = Date.now();
    setLastEvent(event.type || 'unknown');

    if (event.type === 'snapshot') {
      const snapshot = (event.payload?.agent_state as AgentStateSnapshot | undefined) ?? null;
      applySnapshot(snapshot);
      return;
    }

    const callSid = event.call_sid ?? null;
    const payloadStatus = typeof event.payload?.status === 'string'
      ? event.payload.status
      : null;
    const payloadFrom = typeof event.payload?.from === 'string'
      ? event.payload.from
      : null;
    const payloadTo = typeof event.payload?.to === 'string'
      ? event.payload.to
      : null;
    const payloadCommand = typeof event.payload?.command === 'string'
      ? event.payload.command
      : null;
    const payloadCommandId = typeof event.payload?.command_id === 'string'
      ? event.payload.command_id
      : null;
    const localAgentUserId = agentState?.user_id ?? null;

    // Handle outbound connect requests from backend (RDN dial)
    const isOutboundConnectRequest = Boolean(event.payload?.outbound_connect_request);
    const destinationNumber = typeof event.payload?.destination_number === 'string'
      ? event.payload.destination_number
      : null;
    const callerId = typeof event.payload?.caller_id === 'string'
      ? event.payload.caller_id
      : null;
    const callRecordId = typeof event.payload?.call_record_id === 'string'
      ? event.payload.call_record_id
      : null;

    if (isOutboundConnectRequest && destinationNumber && callerId) {
      const requestKey = callRecordId || event.id;
      if (!processedOutboundRequestsRef.current.has(requestKey)) {
        processedOutboundRequestsRef.current.add(requestKey);
        // Clean up old entries
        if (processedOutboundRequestsRef.current.size > 100) {
          const entries = [...processedOutboundRequestsRef.current];
          processedOutboundRequestsRef.current = new Set(entries.slice(-50));
        }

        setMessage(`Llamada saliente solicitada: ${destinationNumber}`);

        // Auto-connect: initiate the outbound call via device.connect()
        void voice.connectOutbound({
          destination: destinationNumber,
          callerId,
          callRecordId: callRecordId || undefined,
        });
      }
      return;
    }

    if (event.type === 'incoming_call' && callSid) {
      // Store conference name if provided (for Tauri to join via device.connect)
      const eventConferenceName = typeof event.payload?.conference_name === 'string'
        ? event.payload.conference_name
        : null;
      if (eventConferenceName) {
        setIncomingConferences((prev) => {
          const next = new Map(prev);
          next.set(callSid, eventConferenceName);
          return next;
        });
      }

      setCalls((prev) => upsertCall(prev, {
        callSid,
        direction: 'inbound',
        status: payloadStatus || 'ringing',
        from: payloadFrom,
        to: payloadTo,
        muted: false,
      }));
    } else if (event.type === 'call_answered' && callSid) {
      stopIncomingRingtone();
      if (event.agent_user_id && localAgentUserId && event.agent_user_id !== localAgentUserId) {
        setCalls((prev) => prev.filter((call) => call.callSid !== callSid));
        setIncomingConferences((prev) => {
          if (!prev.has(callSid)) return prev;
          const next = new Map(prev);
          next.delete(callSid);
          return next;
        });
      } else {
        setCalls((prev) => prev.map((call) => (
          call.callSid === callSid
            ? { ...call, status: 'in_progress' }
            : call
        )));
      }
    } else if (event.type === 'call_updated' && callSid) {
      if (payloadStatus === 'in_progress') {
        stopIncomingRingtone();
      }
      if (payloadStatus === 'in_progress' && event.agent_user_id && localAgentUserId && event.agent_user_id !== localAgentUserId) {
        setCalls((prev) => prev.filter((call) => call.callSid !== callSid));
        setIncomingConferences((prev) => {
          if (!prev.has(callSid)) return prev;
          const next = new Map(prev);
          next.delete(callSid);
          return next;
        });
      } else {
        setCalls((prev) => prev.map((call) => (
          call.callSid === callSid
            ? {
                ...call,
                status: payloadStatus || call.status,
                from: payloadFrom ?? call.from,
                to: payloadTo ?? call.to,
              }
            : call
        )));
      }

      if (payloadCommand === 'accept') {
        void executeRemoteAccept(callSid, payloadCommandId);
      }
    } else if (event.type === 'call_ended' && callSid) {
      setCalls((prev) => prev.filter((call) => call.callSid !== callSid));
      setIncomingConferences((prev) => {
        if (!prev.has(callSid)) return prev;
        const next = new Map(prev);
        next.delete(callSid);
        return next;
      });
    }

    const refreshEvents = new Set([
      'incoming_call',
      'call_answered',
      'call_updated',
      'call_ended',
      'agent_state_changed',
      'call_transfer_completed',
      'conference_updated',
    ]);

    if (refreshEvents.has(event.type)) {
      void refreshAgentSnapshot(`stream:${event.type}`);
    }
  }, [agentState?.user_id, applySnapshot, executeRemoteAccept, refreshAgentSnapshot, stopIncomingRingtone, voice]);

  const hydrateBootstrapAndSession = useCallback(async () => {
    if (!backendUrl) return;

    const bootstrapResult = await fetchBootstrap(backendUrl);
    if (!bootstrapResult.ok) {
      setMessage(`Error bootstrap: ${bootstrapResult.error}`);
      return;
    }
    setBootstrap(bootstrapResult.data);

    const supabase = createClient(
      bootstrapResult.data.auth.supabase_url,
      bootstrapResult.data.auth.supabase_anon_key,
      {
        auth: {
          storageKey: STORAGE_SESSION_KEY,
          autoRefreshToken: true,
          persistSession: true,
        },
      }
    );
    supabaseRef.current = supabase;
    (supabase.auth as typeof supabase.auth & { startAutoRefresh?: () => void }).startAutoRefresh?.();

    const { data } = await supabase.auth.getSession();
    const token = getSessionToken(data.session);
    if (token) {
      setAccessToken(token);
      void primeIncomingRingtone();
    }

    authSubscriptionRef.current?.unsubscribe();
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(getSessionToken(session));
    });
    authSubscriptionRef.current = authListener.subscription;
  }, [backendUrl, primeIncomingRingtone]);

  useEffect(() => {
    const bootstrapTimer = window.setTimeout(() => {
      void hydrateBootstrapAndSession();
    }, 0);

    return () => window.clearTimeout(bootstrapTimer);
  }, [hydrateBootstrapAndSession]);

  useEffect(() => {
    if (!accessToken || !backendUrl) return;
    const snapshotTimer = window.setTimeout(() => {
      void refreshAgentSnapshot('session_ready');
    }, 0);

    const interval = setInterval(() => {
      void refreshAgentSnapshot('fallback_interval');
    }, 45_000);

    return () => {
      window.clearTimeout(snapshotTimer);
      clearInterval(interval);
    };
  }, [accessToken, backendUrl, refreshAgentSnapshot]);

  useEffect(() => {
    if (!accessToken || streamStatus !== 'connected') return;

    const interval = setInterval(() => {
      const silentForMs = Date.now() - lastStreamEventAtRef.current;
      if (silentForMs < STREAM_STALE_TIMEOUT_MS) return;

      setMessage(
        `Stream sin heartbeat/eventos (${Math.round(silentForMs / 1000)}s). Forzando reconexion...`
      );
      sseControllerRef.current?.abort();
    }, STREAM_WATCHDOG_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [accessToken, streamStatus]);

  useEffect(() => {
    if (!accessToken || !backendUrl) return;
    lastWakeTickRef.current = Date.now();

    const interval = setInterval(() => {
      const now = Date.now();
      const gap = now - lastWakeTickRef.current;
      lastWakeTickRef.current = now;

      if (gap < WAKE_GAP_THRESHOLD_MS) return;

      setMessage(
        `Reanudacion detectada tras ${Math.round(gap / 1000)}s. Recuperando sesion y softphone...`
      );
      sseControllerRef.current?.abort();
      void ensureFreshSession('wake_gap', {
        forceRefresh: true,
        silent: true,
      });
      void refreshAgentSnapshot('wake_gap');
      void reconnectVoiceRef.current();
    }, WAKE_GAP_DETECT_MS);

    return () => {
      clearInterval(interval);
    };
  }, [accessToken, backendUrl, ensureFreshSession, refreshAgentSnapshot]);

  useEffect(() => {
    if (!supabaseRef.current || !backendUrl) return;
    let cancelled = false;

    const keepAlive = async (reason: string, forceRefresh = false) => {
      if (cancelled) return;
      await ensureFreshSession(`keepalive:${reason}`, {
        forceRefresh,
        silent: true,
      });
    };

    const recoverRealtime = (reason: string) => {
      const now = Date.now();
      if (now - lastRecoveryTriggerAtRef.current < RECOVERY_RECONNECT_THROTTLE_MS) return;
      lastRecoveryTriggerAtRef.current = now;
      sseControllerRef.current?.abort();
      void refreshAgentSnapshot(`recover:${reason}`);
      void reconnectVoiceRef.current();
      void primeIncomingRingtone();
    };

    void keepAlive('startup', false);

    const interval = setInterval(() => {
      void keepAlive('interval', false);
    }, SESSION_REFRESH_INTERVAL_MS);

    const onFocus = () => {
      void keepAlive('focus', true);
      recoverRealtime('focus');
    };

    const onOnline = () => {
      void keepAlive('online', true);
      recoverRealtime('online');
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void keepAlive('visibility_visible', true);
        recoverRealtime('visibility_visible');
      }
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [backendUrl, ensureFreshSession, primeIncomingRingtone, refreshAgentSnapshot]);

  useEffect(() => {
    if (!accessToken || !backendUrl) return;

    let cancelled = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    const wait = (ms: number) => new Promise<void>((resolve) => {
      waitTimer = setTimeout(() => {
        waitTimer = null;
        resolve();
      }, ms);
    });

    const loop = async () => {
      while (!cancelled) {
        controller = new AbortController();
        sseControllerRef.current = controller;
        const streamToken = await ensureFreshSession('stream:connect', { silent: true });

        if (!streamToken) {
          setStreamStatus('disconnected');
          await wait(3_000);
          continue;
        }

        try {
          await consumeSseStream({
            baseUrl: backendUrl,
            jwt: streamToken,
            signal: controller.signal,
            onStatus: (status) => {
              setStreamStatus(status);
              if (status === 'connected') {
                lastStreamEventAtRef.current = Date.now();
              }
            },
            onEvent: handleCanonicalEvent,
          });
          attempt = 0;
        } catch (err) {
          setStreamStatus('disconnected');
          if (cancelled) break;
          const message = String(err);
          if (isJwtOrAuthError(message)) {
            await ensureFreshSession('stream:auth_error', {
              forceRefresh: true,
              silent: true,
            });
          }
          const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
          attempt += 1;
          setMessage(`Stream reconectando en ${Math.round(delay / 1000)}s (${message})`);
          await wait(delay);
        }
      }
    };

    void loop();

    return () => {
      cancelled = true;
      controller?.abort();
      sseControllerRef.current = null;
      if (waitTimer) {
        clearTimeout(waitTimer);
      }
      setStreamStatus('disconnected');
    };
  }, [accessToken, backendUrl, ensureFreshSession, handleCanonicalEvent]);

  const login = useCallback(async () => {
    if (!supabaseRef.current) {
      setMessage('Bootstrap no cargado todavia');
      return;
    }
    setIsLoading(true);
    setMessage('');
    const { data, error } = await supabaseRef.current.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setIsLoading(false);

    if (error) {
      setMessage(`Login invalido: ${error.message}`);
      return;
    }

    setAccessToken(getSessionToken(data.session));
    void primeIncomingRingtone();
    setMessage('Login correcto');
  }, [email, password, primeIncomingRingtone]);

  const logout = useCallback(async () => {
    const userId = agentState?.user_id;
    if (backendUrl && userId && accessTokenRef.current) {
      await withJwtRetry(
        'availability:logout',
        (jwt) => updateUserAvailability(backendUrl, jwt, userId, false),
      );
      lastSyncedAvailabilityRef.current = false;
    }

    await supabaseRef.current?.auth.signOut();
    setAccessToken('');
    setAgentState(null);
    setCalls([]);
    setMessage('Sesion cerrada');
  }, [agentState?.user_id, backendUrl, withJwtRetry]);

  const executeCallAction = useCallback(async (
    action: 'accept' | 'hangup' | 'mute' | 'unmute',
    callSid: string,
  ) => {
    if (!backendUrl || !accessTokenRef.current) return;

    if (action === 'accept') {
      // Accept incoming call by joining the conference room
      // Use the conference name from SSE event if available, otherwise derive from callSid
      const confName = incomingConferences.get(callSid) || `call-${callSid}`;
      const result = await voice.joinConference({
        conferenceName: confName,
        parentCallSid: callSid,
      });
      if (!result.ok) {
        setMessage(`No se pudo unir a conferencia para ${callSid}: ${result.error}`);
        return;
      }
      stopIncomingRingtone();
      // Clean up the incoming conference mapping
      setIncomingConferences((prev) => {
        const next = new Map(prev);
        next.delete(callSid);
        return next;
      });
      setMessage(`Unido a conferencia para llamada ${callSid}`);
      return;
    }

    if (action === 'hangup') {
      const local = await voice.disconnectCall(callSid);
      const backend = await withJwtRetry(
        `call_hangup:${callSid}`,
        (jwt) => callCommand(
          backendUrl,
          jwt,
          `/api/v1/calls/${callSid}/hangup`,
          { target: 'all' }
        )
      );

      if (!backend.ok) {
        const localInfo = local.ok ? ' (audio local ya desconectado)' : '';
        setMessage(`Error colgar ${callSid}: ${backend.error}${localInfo}`);
        return;
      }

      setMessage(`Llamada ${callSid} colgada`);
      void refreshAgentSnapshot('action:hangup');
      return;
    }

    const wantsMute = action === 'mute';
    const muteResult = await voice.setMuted(callSid, wantsMute);
    if (!muteResult.ok) {
      setMessage(muteResult.error);
      return;
    }

    if (conferenceName.trim()) {
      const path = wantsMute
        ? `/api/v1/calls/${callSid}/mute`
        : `/api/v1/calls/${callSid}/unmute`;

      const backend = await withJwtRetry(
        `call_${action}:${callSid}`,
        (jwt) => callCommand(backendUrl, jwt, path, {
          conference_name: conferenceName.trim(),
        })
      );

      if (!backend.ok) {
        // Rollback local mute state if server mute in conference fails.
        await voice.setMuted(callSid, !wantsMute);
        setMessage(`Error ${action} en conferencia: ${backend.error}`);
        return;
      }
    }

    setMessage(`${wantsMute ? 'Mute' : 'Unmute'} aplicado en ${callSid}`);
    void refreshAgentSnapshot(`action:${action}`);
  }, [backendUrl, conferenceName, incomingConferences, refreshAgentSnapshot, voice, withJwtRetry]);

  useEffect(() => () => {
    authSubscriptionRef.current?.unsubscribe();
    authSubscriptionRef.current = null;
    const supabase = supabaseRef.current;
    if (supabase) {
      (supabase.auth as typeof supabase.auth & { stopAutoRefresh?: () => void }).stopAutoRefresh?.();
    }
    stopIncomingRingtone();
    const context = ringtoneRef.current.context;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {});
    }
    ringtoneRef.current.context = null;
  }, [stopIncomingRingtone]);

  const hasInProgressCalls = useMemo(() => (
    calls.some((call) => call.status === 'in_progress')
  ), [calls]);

  const hasIncomingRingingCalls = useMemo(() => (
    !hasInProgressCalls
    && calls.some((call) => (
      call.direction === 'inbound'
      && (call.status === 'ringing' || call.status === 'in_queue')
    ))
  ), [calls, hasInProgressCalls]);

  useEffect(() => {
    if (!hasInProgressCalls) return;
    stopIncomingRingtone();
  }, [hasInProgressCalls, stopIncomingRingtone]);

  useEffect(() => {
    if (hasIncomingRingingCalls) {
      void startIncomingRingtone();
      return;
    }
    stopIncomingRingtone();
  }, [hasIncomingRingingCalls, startIncomingRingtone, stopIncomingRingtone]);

  const streamBadge = useMemo(() => {
    if (streamStatus === 'connected') return 'Stream conectado';
    if (streamStatus === 'connecting') return 'Stream conectando...';
    return 'Stream desconectado';
  }, [streamStatus]);

  const messageTone = useMemo(() => {
    const text = message.toLowerCase();
    if (
      text.includes('error')
      || text.includes('no se pudo')
      || text.includes('invalido')
      || text.includes('failed')
    ) {
      return 'message-error';
    }
    if (text.includes('reconectando') || text.includes('expirado')) {
      return 'message-warn';
    }
    if (text.includes('correcto') || text.includes('aplicado') || text.includes('aceptada')) {
      return 'message-success';
    }
    return 'message-info';
  }, [message]);

  const isLoggedIn = Boolean(accessToken);

  return (
    <div className="app-shell">
      <div className="halo halo-left" aria-hidden />
      <div className="halo halo-right" aria-hidden />

      <main className={isLoggedIn ? 'layout layout-live' : 'layout layout-login'}>
        <header className="card hero-card">
          <p className="eyebrow">Centralita RDN</p>
          <h1>RDN Voice Agent</h1>
          <p className="muted">
            Cliente desktop de voz real con estado canonico + media Twilio.
          </p>
          {bootstrap && (
            <p className="muted muted-compact">
              Auth: {bootstrap.auth.mode} - API: {bootstrap.backend.api_base_path}
            </p>
          )}
        </header>

        {!isLoggedIn && (
          <section className="card login-card">
            <h2>Acceso de agente</h2>
            <p className="muted">Usa las mismas credenciales de la web de Centralita.</p>
            <div className="grid">
              <label>
                Email
                <input
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="agente@empresa.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void login();
                    }
                  }}
                />
              </label>
              <button disabled={isLoading} onClick={() => void login()}>
                {isLoading ? 'Entrando...' : 'Entrar'}
              </button>
            </div>
          </section>
        )}

        {isLoggedIn && (
          <>
            <section className="card grid">
              <h2>Estado operativo</h2>
              <p><strong>Agente:</strong> {agentState?.user_id ?? 'desconocido'}</p>
              <p><strong>Identidad Voice:</strong> {voice.identity || 'sin resolver'}</p>
              <p><strong>Operativo:</strong> {operationalLabel(agentState?.operational_status ?? 'unknown')}</p>
              <p><strong>Llamadas activas:</strong> {agentState?.active_calls_count ?? 0}</p>
              <p><strong>Fuente:</strong> {agentState?.source_of_truth ?? 'n/a'}</p>
              <p><strong>Canal:</strong> {streamBadge}</p>
              <p><strong>Ultimo evento:</strong> {lastEvent}</p>
              <div className="actions">
                <button onClick={() => void refreshAgentSnapshot('manual')}>Refrescar estado</button>
                <button onClick={() => void logout()}>Salir</button>
              </div>
            </section>

            <section className="card grid">
              <h2>Motor de voz</h2>
              <p>
                <strong>Device:</strong>{' '}
                <span className={voiceStatusClass(voice.deviceStatus)}>
                  {voiceStatusLabel(voice.deviceStatus)}
                </span>
              </p>
              <p><strong>Detalle:</strong> {voice.deviceReason}</p>
              <p><strong>Token:</strong> {voice.tokenExpired ? 'expirado/renovando' : 'vigente'}</p>
              <p><strong>Llamadas enlazadas al softphone:</strong> {voice.attachedCallSids.length}</p>
              {voice.lastError && (
                <p className="muted"><strong>Ultimo error:</strong> {voice.lastError}</p>
              )}
              <div className="actions">
                <button onClick={() => void voice.reconnectNow()}>Reiniciar motor de voz</button>
              </div>
            </section>

            <section className="card grid">
              <h2>Llamadas</h2>
              <label>
                conference_name (opcional para mute/unmute en conferencia de backend)
                <input
                  value={conferenceName}
                  onChange={(e) => setConferenceName(e.target.value)}
                  placeholder="conf-123"
                />
              </label>
              {calls.length === 0 && (
                <p className="muted">Sin llamadas activas/ringing.</p>
              )}

              {calls.map((call) => {
                const attached = voice.isCallAttached(call.callSid);
                const hasKnownConference = incomingConferences.has(call.callSid);
                const canAccept = (attached || hasKnownConference) && call.status !== 'in_progress';
                const canToggleMute = attached && call.status === 'in_progress';
                const muteNeedsConference = Boolean(conferenceName.trim());

                return (
                  <article key={call.callSid} className="call-row">
                    <div>
                      <p><strong>{call.callSid}</strong></p>
                      <p className="muted">
                        {call.direction} - {call.status} - {call.from ?? '-'} -&gt; {call.to ?? '-'}
                      </p>
                      <p className="muted">
                        Motor local: {attached ? 'media enlazada' : 'sin media local enlazada'}
                      </p>
                      {!attached && (
                        <p className="muted">
                          Aceptar/mute requiere que esta llamada llegue al softphone local.
                        </p>
                      )}
                      {attached && !muteNeedsConference && (
                        <p className="muted">
                          Mute sin conference_name aplica mute local de microfono.
                        </p>
                      )}
                      {attached && muteNeedsConference && (
                        <p className="muted">
                          Mute aplicara media local + endpoint de conferencia en backend.
                        </p>
                      )}
                    </div>
                    <div className="actions">
                      <button
                        disabled={!canAccept}
                        onClick={() => void executeCallAction('accept', call.callSid)}
                        title={canAccept ? 'Aceptar llamada real' : 'No hay incoming local para aceptar'}
                      >
                        Aceptar
                      </button>
                      <button onClick={() => void executeCallAction('hangup', call.callSid)}>
                        Colgar
                      </button>
                      <button
                        disabled={!canToggleMute}
                        onClick={() => void executeCallAction(call.muted ? 'unmute' : 'mute', call.callSid)}
                        title={canToggleMute ? 'Mutear/Desmutear llamada real' : 'Mute requiere llamada en media local activa'}
                      >
                        {call.muted ? 'Unmute' : 'Mute'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          </>
        )}

        {message && (
          <section className={`card message-card ${messageTone}`}>
            <p>{message}</p>
          </section>
        )}
      </main>
    </div>
  );
}

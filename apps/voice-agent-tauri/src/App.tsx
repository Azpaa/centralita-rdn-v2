import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import {
  type ApiResult,
  callCommand,
  consumeSseStream,
  fetchAgentState,
  fetchBootstrap,
  normalizeBaseUrl,
} from './lib/backend';
import type {
  AgentStateSnapshot,
  BootstrapPayload,
  CanonicalStreamEvent,
  VoiceCallView,
  VoiceDeviceStatus,
} from './lib/types';
import { useVoiceEngine } from './lib/voice-engine';

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
const REMOTE_ACCEPT_RETRY_DELAY_MS = 350;
const REMOTE_ACCEPT_MAX_ATTEMPTS = 5;
const REMOTE_COMMAND_TTL_MS = 10 * 60_000;
const REMOTE_COMMAND_MAX_TRACKED = 200;

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
  const reconnectVoiceRef = useRef<() => Promise<void>>(async () => {});

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
        if (!silent) {
          setMessage(
            `Sesion no valida (${reason}): ${refreshResult.error?.message || 'sin session'}`
          );
        }
        setAccessToken('');
        return '';
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

  const handleVoiceIncoming = useCallback((event: {
    callSid: string;
    from: string | null;
    to: string | null;
    direction: 'inbound' | 'outbound';
    autoAdopted: boolean;
  }) => {
    setCalls((prev) => upsertCall(prev, {
      callSid: event.callSid,
      direction: event.direction,
      status: event.autoAdopted ? 'in_progress' : 'ringing',
      from: event.from,
      to: event.to,
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

  const voice = useVoiceEngine({
    baseUrl: backendUrl,
    accessToken,
    onIncomingCall: handleVoiceIncoming,
    onCallAccepted: handleVoiceAccepted,
    onCallEnded: handleVoiceEnded,
    onCallMutedChanged: handleVoiceMutedChanged,
    onInfo: handleVoiceInfo,
  });

  useEffect(() => {
    reconnectVoiceRef.current = voice.reconnectNow;
  }, [voice.reconnectNow]);

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
      for (let attempt = 1; attempt <= REMOTE_ACCEPT_MAX_ATTEMPTS; attempt += 1) {
        const result = await voice.acceptCall(callSid);
        if (result.ok) {
          if (commandId) markRemoteCommandProcessed(commandId);
          setMessage(`Orden remota ejecutada: llamada ${callSid} aceptada.`);
          return;
        }

        const shouldRetry = !voice.isCallAttached(callSid) && attempt < REMOTE_ACCEPT_MAX_ATTEMPTS;
        if (shouldRetry) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, REMOTE_ACCEPT_RETRY_DELAY_MS);
          });
          continue;
        }

        setMessage(`No se pudo ejecutar accept remoto en ${callSid}: ${result.error}`);
        return;
      }
    } finally {
      remoteAcceptInFlightRef.current.delete(callSid);
    }
  }, [markRemoteCommandProcessed, voice, wasRemoteCommandProcessed]);

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

    if (event.type === 'incoming_call' && callSid) {
      setCalls((prev) => upsertCall(prev, {
        callSid,
        direction: 'inbound',
        status: payloadStatus || 'ringing',
        from: payloadFrom,
        to: payloadTo,
        muted: false,
      }));
    } else if (event.type === 'call_answered' && callSid) {
      setCalls((prev) => prev.map((call) => (
        call.callSid === callSid
          ? { ...call, status: 'in_progress' }
          : call
      )));
    } else if (event.type === 'call_updated' && callSid) {
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

      if (payloadCommand === 'accept') {
        void executeRemoteAccept(callSid, payloadCommandId);
      }
    } else if (event.type === 'call_ended' && callSid) {
      setCalls((prev) => prev.filter((call) => call.callSid !== callSid));
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
  }, [applySnapshot, executeRemoteAccept, refreshAgentSnapshot]);

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
    if (token) setAccessToken(token);

    authSubscriptionRef.current?.unsubscribe();
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(getSessionToken(session));
    });
    authSubscriptionRef.current = authListener.subscription;
  }, [backendUrl]);

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

    void keepAlive('startup', false);

    const interval = setInterval(() => {
      void keepAlive('interval', false);
    }, SESSION_REFRESH_INTERVAL_MS);

    const onFocus = () => {
      void keepAlive('focus', true);
    };

    const onOnline = () => {
      void keepAlive('online', true);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void keepAlive('visibility_visible', true);
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
  }, [backendUrl, ensureFreshSession]);

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
    setMessage('Login correcto');
  }, [email, password]);

  const logout = useCallback(async () => {
    await supabaseRef.current?.auth.signOut();
    setAccessToken('');
    setAgentState(null);
    setCalls([]);
    setMessage('Sesion cerrada');
  }, []);

  const executeCallAction = useCallback(async (
    action: 'accept' | 'hangup' | 'mute' | 'unmute',
    callSid: string,
  ) => {
    if (!backendUrl || !accessTokenRef.current) return;

    if (action === 'accept') {
      const result = await voice.acceptCall(callSid);
      if (!result.ok) {
        setMessage(`No se pudo aceptar ${callSid}: ${result.error}`);
        return;
      }
      setMessage(`Llamada ${callSid} aceptada en softphone`);
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
  }, [backendUrl, conferenceName, refreshAgentSnapshot, voice, withJwtRetry]);

  useEffect(() => () => {
    authSubscriptionRef.current?.unsubscribe();
    authSubscriptionRef.current = null;
    const supabase = supabaseRef.current;
    if (supabase) {
      (supabase.auth as typeof supabase.auth & { stopAutoRefresh?: () => void }).stopAutoRefresh?.();
    }
  }, []);

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
                const canAccept = attached && call.status !== 'in_progress';
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

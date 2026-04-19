import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Call, Device } from '@twilio/voice-sdk';
import { fetchVoiceToken, type ApiResult } from './backend';
import type { VoiceDeviceStatus } from './types';

/**
 * Voice engine for Tauri desktop app.
 *
 * KEY DESIGN: This engine does NOT use device.register().
 * WebView2 (Tauri) cannot reliably register Twilio Devices because
 * the WebSocket-based signaling connection fails in the embedded browser.
 *
 * Instead, this engine:
 *  1. Creates a Device with a valid token (for connect capability)
 *  2. Listens for SSE events from the backend (incoming calls, outbound requests)
 *  3. Uses device.connect() to initiate calls (outbound or conference join)
 *
 * device.connect() does NOT require device.register() — it just needs a valid token.
 */

const TOKEN_REFRESH_INTERVAL_MS = 25 * 60_000; // 25 minutes

type VoiceActionResult = ApiResult<{
  call_sid: string;
}>;

type ManagedCall = {
  call: Call;
  sid: string;
  muted: boolean;
  direction: 'inbound' | 'outbound';
  destination: string | null;
};

type UseVoiceEngineParams = {
  baseUrl: string;
  accessToken: string;
  onCallStarted?: (callSid: string, direction: 'inbound' | 'outbound', destination: string | null) => void;
  onCallAccepted?: (callSid: string) => void;
  onCallEnded?: (callSid: string) => void;
  onCallMutedChanged?: (callSid: string, muted: boolean) => void;
  onInfo?: (message: string) => void;
};

type UseVoiceEngineResult = {
  deviceStatus: VoiceDeviceStatus;
  deviceReason: string;
  identity: string;
  tokenExpired: boolean;
  lastError: string | null;
  attachedCallSids: string[];
  connectOutbound: (params: {
    destination: string;
    callerId: string;
    callRecordId?: string;
  }) => Promise<VoiceActionResult>;
  joinConference: (params: {
    conferenceName: string;
    parentCallSid?: string;
  }) => Promise<VoiceActionResult>;
  disconnectCall: (callSid: string) => Promise<VoiceActionResult>;
  setMuted: (callSid: string, muted: boolean) => Promise<VoiceActionResult>;
  isCallAttached: (callSid: string) => boolean;
  reconnectNow: () => Promise<void>;
};

function isAuthOrSessionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('jwt')
    || normalized.includes('sesion')
    || normalized.includes('session')
    || normalized.includes('401')
    || normalized.includes('unauthorized')
  );
}

async function ensureMicrophonePermission(): Promise<ApiResult<{ granted: true }>> {
  if (
    typeof navigator === 'undefined'
    || !navigator.mediaDevices
    || typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    return { ok: false, error: 'MediaDevices no disponible en este runtime.' };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true, data: { granted: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'permiso_microfono_denegado';
    return { ok: false, error: message };
  }
}

export function useVoiceEngine(params: UseVoiceEngineParams): UseVoiceEngineResult {
  const {
    baseUrl,
    accessToken,
    onCallStarted,
    onCallAccepted,
    onCallEnded,
    onCallMutedChanged,
    onInfo,
  } = params;

  const [deviceStatus, setDeviceStatus] = useState<VoiceDeviceStatus>('disconnected');
  const [deviceReason, setDeviceReason] = useState('Motor de voz detenido');
  const [identity, setIdentity] = useState('');
  const [tokenExpired, setTokenExpired] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [attachedCallSids, setAttachedCallSids] = useState<string[]>([]);

  const deviceRef = useRef<Device | null>(null);
  const callsRef = useRef<Map<string, ManagedCall>>(new Map());
  const identityRef = useRef('');
  const baseUrlRef = useRef(baseUrl);
  const accessTokenRef = useRef(accessToken);
  const microphoneReadyRef = useRef(false);
  const initInFlightRef = useRef(false);
  const enabledRef = useRef(false);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCallStartedRef = useRef(onCallStarted);
  const onCallAcceptedRef = useRef(onCallAccepted);
  const onCallEndedRef = useRef(onCallEnded);
  const onCallMutedChangedRef = useRef(onCallMutedChanged);
  const onInfoRef = useRef(onInfo);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
    accessTokenRef.current = accessToken;
  }, [baseUrl, accessToken]);

  useEffect(() => {
    onCallStartedRef.current = onCallStarted;
    onCallAcceptedRef.current = onCallAccepted;
    onCallEndedRef.current = onCallEnded;
    onCallMutedChangedRef.current = onCallMutedChanged;
    onInfoRef.current = onInfo;
  }, [onCallStarted, onCallAccepted, onCallEnded, onCallMutedChanged, onInfo]);

  const syncAttachedCallSids = useCallback(() => {
    setAttachedCallSids(Array.from(callsRef.current.keys()));
  }, []);

  const setHealthy = useCallback((reason: string) => {
    setDeviceStatus('connected');
    setDeviceReason(reason);
    setLastError(null);
    setTokenExpired(false);
  }, []);

  const setProblem = useCallback((status: Exclude<VoiceDeviceStatus, 'connected'>, reason: string) => {
    setDeviceStatus(status);
    setDeviceReason(reason);
  }, []);

  const removeManagedCall = useCallback((callSid: string) => {
    if (!callsRef.current.has(callSid)) return;
    callsRef.current.delete(callSid);
    syncAttachedCallSids();
    onCallEndedRef.current?.(callSid);
  }, [syncAttachedCallSids]);

  const wireCallLifecycle = useCallback((call: Call, callSid: string, direction: 'inbound' | 'outbound', destination: string | null) => {
    callsRef.current.set(callSid, {
      call,
      sid: callSid,
      muted: false,
      direction,
      destination,
    });
    syncAttachedCallSids();

    call.on('accept', () => {
      onCallAcceptedRef.current?.(callSid);
    });

    call.on('disconnect', () => {
      removeManagedCall(callSid);
    });

    call.on('cancel', () => {
      removeManagedCall(callSid);
    });

    call.on('reject', () => {
      removeManagedCall(callSid);
    });

    call.on('error', (err: { message?: string }) => {
      const message = err.message || 'Error en llamada de voz';
      setLastError(message);
      onInfoRef.current?.(`Error de llamada ${callSid}: ${message}`);
      removeManagedCall(callSid);
    });
  }, [removeManagedCall, syncAttachedCallSids]);

  // Create or refresh the Device with a fresh token.
  // We do NOT call device.register() — just keep a Device ready for connect().
  const ensureDevice = useCallback(async (reason: string): Promise<Device | null> => {
    if (initInFlightRef.current) return deviceRef.current;
    initInFlightRef.current = true;

    try {
      setProblem('reconnecting', `Preparando motor de voz (${reason})`);

      if (!microphoneReadyRef.current) {
        const permission = await ensureMicrophonePermission();
        if (!permission.ok) {
          setLastError(permission.error);
          setProblem('degraded', `Microfono no disponible: ${permission.error}`);
          return null;
        }
        microphoneReadyRef.current = true;
      }

      const tokenResult = await fetchVoiceToken(baseUrlRef.current, accessTokenRef.current);
      if (!tokenResult.ok) {
        setLastError(tokenResult.error);

        if (isAuthOrSessionError(tokenResult.error)) {
          setTokenExpired(true);
          setProblem('degraded', 'Sesion invalida para token de voz');
          return null;
        }

        setProblem('degraded', `No se pudo obtener token de voz: ${tokenResult.error}`);
        return null;
      }

      identityRef.current = tokenResult.data.identity;
      setIdentity(tokenResult.data.identity);
      setTokenExpired(false);

      // Update existing device token or create a new one
      if (deviceRef.current) {
        try {
          deviceRef.current.updateToken(tokenResult.data.token);
          setHealthy('Token renovado — listo para llamadas');
          return deviceRef.current;
        } catch {
          try { deviceRef.current.destroy(); } catch { /* ignore */ }
          deviceRef.current = null;
        }
      }

      const device = new Device(tokenResult.data.token, {
        logLevel: 1,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        closeProtection: true,
      });

      device.on('error', (err: { code?: number; message?: string }) => {
        const code = err.code ?? 0;
        const message = err.message || `Error de device (${code})`;
        setLastError(message);
        onInfoRef.current?.(`Error de softphone ${code}: ${message}`);
      });

      device.on('tokenWillExpire', async () => {
        setTokenExpired(true);
        onInfoRef.current?.('Token de voz proximo a expirar; refrescando');

        const refresh = await fetchVoiceToken(baseUrlRef.current, accessTokenRef.current);
        if (!refresh.ok) {
          setLastError(refresh.error);
          setProblem('degraded', `No se pudo refrescar token: ${refresh.error}`);
          return;
        }

        try {
          device.updateToken(refresh.data.token);
          setTokenExpired(false);
          setHealthy('Token renovado');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'token_update_failed';
          setLastError(message);
          setProblem('degraded', `Error aplicando token: ${message}`);
        }
      });

      deviceRef.current = device;
      setHealthy('Motor de voz listo (modo connect)');
      return device;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'init_device_failed';
      setLastError(message);
      setProblem('degraded', `Error inicializando motor de voz: ${message}`);
      return null;
    } finally {
      initInFlightRef.current = false;
    }
  }, [setHealthy, setProblem]);

  // Initialize device when session is ready
  useEffect(() => {
    if (!baseUrl || !accessToken) {
      enabledRef.current = false;
      if (tokenRefreshTimerRef.current) {
        clearInterval(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* ignore */ }
        deviceRef.current = null;
      }
      callsRef.current.clear();
      syncAttachedCallSids();
      setIdentity('');
      setTokenExpired(false);
      setLastError(null);
      setDeviceStatus('disconnected');
      setDeviceReason('Sesion cerrada o backend no configurado');
      microphoneReadyRef.current = false;
      return;
    }

    enabledRef.current = true;
    void ensureDevice('session_ready');

    tokenRefreshTimerRef.current = setInterval(() => {
      if (!enabledRef.current) return;
      void ensureDevice('token_refresh_interval');
    }, TOKEN_REFRESH_INTERVAL_MS);

    return () => {
      enabledRef.current = false;
      if (tokenRefreshTimerRef.current) {
        clearInterval(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* ignore */ }
        deviceRef.current = null;
      }
      callsRef.current.clear();
      syncAttachedCallSids();
      setDeviceStatus('disconnected');
      setDeviceReason('Motor de voz detenido');
    };
  }, [accessToken, baseUrl, ensureDevice, syncAttachedCallSids]);

  // ─── Call actions ────────────────────────────────────────────────────────

  const connectOutbound = useCallback(async (connectParams: {
    destination: string;
    callerId: string;
    callRecordId?: string;
  }): Promise<VoiceActionResult> => {
    try {
      let device = deviceRef.current;
      if (!device) {
        device = await ensureDevice('connect_outbound');
        if (!device) {
          return { ok: false, error: 'No se pudo preparar el motor de voz.' };
        }
      }

      onInfoRef.current?.(`Conectando llamada saliente a ${connectParams.destination}`);

      const call = await device.connect({
        params: {
          To: connectParams.destination,
          CallerId: connectParams.callerId,
          UserId: identityRef.current,
          CallRecordId: connectParams.callRecordId || '',
        },
      });

      const callSid = call.parameters?.CallSid || `outbound-${Date.now()}`;
      wireCallLifecycle(call, callSid, 'outbound', connectParams.destination);
      onCallStartedRef.current?.(callSid, 'outbound', connectParams.destination);

      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'connect_outbound_failed';
      setLastError(message);
      onInfoRef.current?.(`Error conectando llamada saliente: ${message}`);
      return { ok: false, error: message };
    }
  }, [ensureDevice, wireCallLifecycle]);

  const joinConference = useCallback(async (conferenceParams: {
    conferenceName: string;
    parentCallSid?: string;
  }): Promise<VoiceActionResult> => {
    try {
      let device = deviceRef.current;
      if (!device) {
        device = await ensureDevice('join_conference');
        if (!device) {
          return { ok: false, error: 'No se pudo preparar el motor de voz.' };
        }
      }

      onInfoRef.current?.(`Uniendose a conferencia ${conferenceParams.conferenceName}`);

      const call = await device.connect({
        params: {
          To: `conference:${conferenceParams.conferenceName}`,
          UserId: identityRef.current,
          ParentCallSid: conferenceParams.parentCallSid || '',
        },
      });

      const callSid = call.parameters?.CallSid || `conf-${Date.now()}`;
      wireCallLifecycle(call, callSid, 'inbound', null);
      onCallStartedRef.current?.(callSid, 'inbound', null);

      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'join_conference_failed';
      setLastError(message);
      onInfoRef.current?.(`Error uniendose a conferencia: ${message}`);
      return { ok: false, error: message };
    }
  }, [ensureDevice, wireCallLifecycle]);

  const disconnectCall = useCallback(async (callSid: string): Promise<VoiceActionResult> => {
    const managed = callsRef.current.get(callSid);
    if (!managed) {
      return { ok: false, error: 'La llamada no esta enlazada localmente al softphone.' };
    }

    try {
      managed.call.disconnect();
      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'disconnect_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

  const setMuted = useCallback(async (callSid: string, muted: boolean): Promise<VoiceActionResult> => {
    const managed = callsRef.current.get(callSid);
    if (!managed) {
      return { ok: false, error: 'No hay media local para mutear/desmutear esta llamada.' };
    }

    try {
      managed.call.mute(muted);
      managed.muted = muted;
      onCallMutedChangedRef.current?.(callSid, muted);
      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'mute_toggle_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

  const isCallAttached = useCallback((callSid: string) => {
    return callsRef.current.has(callSid);
  }, []);

  const reconnectNow = useCallback(async () => {
    if (!enabledRef.current) {
      const message = 'No se puede reiniciar el motor: sesion no activa o backend no configurado.';
      setLastError(message);
      onInfoRef.current?.(message);
      return;
    }
    if (initInFlightRef.current) {
      onInfoRef.current?.('El motor de voz ya se esta inicializando.');
      return;
    }
    if (deviceRef.current) {
      try { deviceRef.current.destroy(); } catch { /* ignore */ }
      deviceRef.current = null;
    }
    await ensureDevice('manual');
  }, [ensureDevice]);

  return useMemo(() => ({
    deviceStatus,
    deviceReason,
    identity,
    tokenExpired,
    lastError,
    attachedCallSids,
    connectOutbound,
    joinConference,
    disconnectCall,
    setMuted,
    isCallAttached,
    reconnectNow,
  }), [
    attachedCallSids,
    connectOutbound,
    deviceReason,
    deviceStatus,
    disconnectCall,
    identity,
    isCallAttached,
    joinConference,
    lastError,
    reconnectNow,
    setMuted,
    tokenExpired,
  ]);
}

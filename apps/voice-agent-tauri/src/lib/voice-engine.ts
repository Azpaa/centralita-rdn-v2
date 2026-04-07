import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Call, Device } from '@twilio/voice-sdk';
import { fetchCallByTwilioSid, fetchVoiceToken, type ApiResult } from './backend';
import type { VoiceDeviceStatus } from './types';

const DEVICE_REGISTER_TIMEOUT_MS = 20_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const ADOPTION_LOOKUP_RETRIES = 3;
const ADOPTION_LOOKUP_RETRY_DELAY_MS = 150;

const ADOPTABLE_SOURCES = new Set([
  'rdn',
  'backend_outbound',
  'rdn_adopted',
  'rdn_adopted_browser',
]);

type VoiceActionResult = ApiResult<{
  call_sid: string;
}>;

type IncomingCallEvent = {
  callSid: string;
  from: string | null;
  to: string | null;
  direction: 'inbound' | 'outbound';
  autoAdopted: boolean;
};

type ManagedCall = {
  call: Call;
  sid: string;
  muted: boolean;
};

type UseVoiceEngineParams = {
  baseUrl: string;
  accessToken: string;
  onIncomingCall?: (event: IncomingCallEvent) => void;
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
  acceptCall: (callSid: string) => Promise<VoiceActionResult>;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerDeviceWithTimeout(device: Device, reason: string): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      device.register(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`register_timeout:${reason}`));
        }, DEVICE_REGISTER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function readCallParameter(call: Call, key: string): string {
  const parameters = call.parameters as Record<string, unknown> | undefined;
  const value = parameters?.[key];
  return typeof value === 'string' ? value : '';
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
    onIncomingCall,
    onCallAccepted,
    onCallEnded,
    onCallMutedChanged,
    onInfo,
  } = params;

  const [deviceStatus, setDeviceStatus] = useState<VoiceDeviceStatus>('disconnected');
  const [deviceReason, setDeviceReason] = useState('Softphone detenido');
  const [identity, setIdentity] = useState('');
  const [tokenExpired, setTokenExpired] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [attachedCallSids, setAttachedCallSids] = useState<string[]>([]);

  const deviceRef = useRef<Device | null>(null);
  const callsRef = useRef<Map<string, ManagedCall>>(new Map());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const initInFlightRef = useRef(false);
  const initializeDeviceRef = useRef<((trigger: string) => Promise<void>) | null>(null);
  const suppressDestroyedReconnectRef = useRef(false);
  const enabledRef = useRef(false);
  const microphoneReadyRef = useRef(false);
  const identityRef = useRef('');
  const deviceStatusRef = useRef<VoiceDeviceStatus>('disconnected');
  const baseUrlRef = useRef(baseUrl);
  const accessTokenRef = useRef(accessToken);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
    accessTokenRef.current = accessToken;
  }, [baseUrl, accessToken]);

  useEffect(() => {
    deviceStatusRef.current = deviceStatus;
  }, [deviceStatus]);

  const syncAttachedCallSids = useCallback(() => {
    setAttachedCallSids(Array.from(callsRef.current.keys()));
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const softResetDevice = useCallback(() => {
    if (!deviceRef.current) return;
    suppressDestroyedReconnectRef.current = true;
    try {
      deviceRef.current?.destroy();
    } catch {
      // ignore destroy errors
    }
    deviceRef.current = null;
    setTimeout(() => {
      suppressDestroyedReconnectRef.current = false;
    }, 0);
  }, []);

  const clearCalls = useCallback(() => {
    callsRef.current.clear();
    syncAttachedCallSids();
  }, [syncAttachedCallSids]);

  const setHealthy = useCallback((reason: string) => {
    setDeviceStatus('connected');
    setDeviceReason(reason);
    setLastError(null);
    setTokenExpired(false);
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
  }, [clearReconnectTimer]);

  const setProblem = useCallback((status: Exclude<VoiceDeviceStatus, 'connected'>, reason: string) => {
    setDeviceStatus(status);
    setDeviceReason(reason);
  }, []);

  const scheduleReconnect = useCallback((reason: string, delayMs?: number) => {
    if (!enabledRef.current) return;
    if (reconnectTimerRef.current) return;

    reconnectAttemptsRef.current += 1;
    const retryInMs = delayMs ?? Math.min(20_000, 1_000 * 2 ** Math.min(reconnectAttemptsRef.current, 4));
    setProblem('reconnecting', `Reintentando registro (${Math.round(retryInMs / 1000)}s): ${reason}`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const runInit = initializeDeviceRef.current;
      if (!runInit) return;
      void runInit(`reconnect:${reason}`);
    }, retryInMs);
  }, [setProblem]);

  const removeManagedCall = useCallback((callSid: string) => {
    if (!callsRef.current.has(callSid)) return;
    callsRef.current.delete(callSid);
    syncAttachedCallSids();
    onCallEnded?.(callSid);
  }, [onCallEnded, syncAttachedCallSids]);

  const evaluateAutoAdopt = useCallback(async (callSid: string): Promise<{
    autoAdopt: boolean;
    toNumber: string | null;
  }> => {
    for (let attempt = 0; attempt < ADOPTION_LOOKUP_RETRIES; attempt += 1) {
      const result = await fetchCallByTwilioSid(baseUrlRef.current, accessTokenRef.current, callSid);
      if (!result.ok) {
        if (attempt < ADOPTION_LOOKUP_RETRIES - 1) {
          await delay(ADOPTION_LOOKUP_RETRY_DELAY_MS);
          continue;
        }
        return { autoAdopt: false, toNumber: null };
      }

      const record = result.data;
      if (!record) {
        if (attempt < ADOPTION_LOOKUP_RETRIES - 1) {
          await delay(ADOPTION_LOOKUP_RETRY_DELAY_MS);
          continue;
        }
        return { autoAdopt: false, toNumber: null };
      }

      const rawSource = record.twilio_data?.source;
      const source = typeof rawSource === 'string' ? rawSource : '';
      const isOutboundAdoptable = record.direction === 'outbound' && ADOPTABLE_SOURCES.has(source);
      if (!isOutboundAdoptable) return { autoAdopt: false, toNumber: null };

      if (record.answered_by_user_id && record.answered_by_user_id !== identityRef.current) {
        return { autoAdopt: false, toNumber: null };
      }

      return { autoAdopt: true, toNumber: record.to_number || null };
    }

    return { autoAdopt: false, toNumber: null };
  }, []);

  const wireCallLifecycle = useCallback((call: Call, callSid: string) => {
    call.on('accept', () => {
      onCallAccepted?.(callSid);
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
      onInfo?.(`Error de llamada ${callSid}: ${message}`);
      removeManagedCall(callSid);
    });
  }, [onCallAccepted, onInfo, removeManagedCall]);

  const handleIncomingCall = useCallback(async (call: Call) => {
    const callSid = readCallParameter(call, 'CallSid');
    if (!callSid) {
      setLastError('Llamada entrante sin CallSid. No se puede enlazar.');
      return;
    }

    if (callsRef.current.has(callSid)) {
      return;
    }

    callsRef.current.set(callSid, {
      call,
      sid: callSid,
      muted: false,
    });
    syncAttachedCallSids();
    wireCallLifecycle(call, callSid);

    let direction: 'inbound' | 'outbound' = 'inbound';
    let toNumber = readCallParameter(call, 'To') || null;
    let autoAdopted = false;

    try {
      const adoption = await evaluateAutoAdopt(callSid);
      if (adoption.autoAdopt) {
        autoAdopted = true;
        direction = 'outbound';
        toNumber = adoption.toNumber;
        onInfo?.(`Auto-adopcion activada para llamada ${callSid}`);
        call.accept();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'lookup_adoption_failed';
      onInfo?.(`No se pudo evaluar adopcion de llamada ${callSid}: ${message}`);
    }

    onIncomingCall?.({
      callSid,
      from: readCallParameter(call, 'From') || null,
      to: toNumber,
      direction,
      autoAdopted,
    });
  }, [evaluateAutoAdopt, onIncomingCall, onInfo, syncAttachedCallSids, wireCallLifecycle]);

  const wireDeviceLifecycle = useCallback((device: Device) => {
    device.on('registering', () => {
      setProblem('registering', 'Registrando softphone...');
    });

    device.on('registered', () => {
      setHealthy('Softphone registrado');
    });

    device.on('unregistered', () => {
      setProblem('degraded', 'Softphone desregistrado');
      scheduleReconnect('device_unregistered', 2_000);
    });

    device.on('destroyed', () => {
      if (suppressDestroyedReconnectRef.current) {
        suppressDestroyedReconnectRef.current = false;
        return;
      }

      if (!enabledRef.current) {
        setProblem('disconnected', 'Softphone detenido');
        return;
      }

      setProblem('degraded', 'Softphone destruido');
      scheduleReconnect('device_destroyed', 2_000);
    });

    device.on('error', (err: { code?: number; message?: string }) => {
      const code = err.code ?? 0;
      const message = err.message || `Error de device (${code})`;
      setLastError(message);
      onInfo?.(`Error de softphone ${code}: ${message}`);

      if (code === 31204 || code === 31205 || code === 31009) {
        setTokenExpired(true);
        setProblem('degraded', 'Token o transporte invalido; reconectando');
        scheduleReconnect(`device_error_${code}`, 2_000);
        return;
      }

      setProblem('degraded', message);
      scheduleReconnect(`device_error_${code}`, 3_000);
    });

    device.on('tokenWillExpire', async () => {
      setTokenExpired(true);
      onInfo?.('Token de voz proximo a expirar; refrescando');

      const refresh = await fetchVoiceToken(baseUrlRef.current, accessTokenRef.current);
      if (!refresh.ok) {
        setLastError(refresh.error);
        setProblem('degraded', `No se pudo refrescar token: ${refresh.error}`);
        scheduleReconnect('token_refresh_failed', 2_000);
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
        scheduleReconnect('token_update_failed', 2_000);
      }
    });

    device.on('incoming', (call: Call) => {
      void handleIncomingCall(call);
    });
  }, [handleIncomingCall, onInfo, scheduleReconnect, setHealthy, setProblem]);

  const initializeDevice = useCallback(async (trigger: string) => {
    if (!enabledRef.current) return;
    if (initInFlightRef.current) return;
    initInFlightRef.current = true;

    try {
      clearReconnectTimer();
      setProblem('reconnecting', `Inicializando softphone (${trigger})`);

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setProblem('degraded', 'Sin conectividad de red');
        scheduleReconnect('offline', 3_000);
        return;
      }

      if (!microphoneReadyRef.current) {
        const permission = await ensureMicrophonePermission();
        if (!permission.ok) {
          setLastError(permission.error);
          setProblem('degraded', `Microfono no disponible: ${permission.error}`);
          return;
        }
        microphoneReadyRef.current = true;
      }

      const tokenResult = await fetchVoiceToken(baseUrlRef.current, accessTokenRef.current);
      if (!tokenResult.ok) {
        setLastError(tokenResult.error);

        if (isAuthOrSessionError(tokenResult.error)) {
          setTokenExpired(true);
          setProblem('degraded', 'Sesion invalida para token de voz');
          return;
        }

        setProblem('degraded', `No se pudo obtener token de voz: ${tokenResult.error}`);
        scheduleReconnect('token_fetch_failed');
        return;
      }

      identityRef.current = tokenResult.data.identity;
      setIdentity(tokenResult.data.identity);
      setTokenExpired(false);

      if (deviceRef.current) {
        try {
          deviceRef.current.updateToken(tokenResult.data.token);
          setProblem('registering', 'Renovando registro del softphone...');
          await registerDeviceWithTimeout(deviceRef.current, 'refresh_existing_device');
          return;
        } catch {
          softResetDevice();
        }
      }

      const device = new Device(tokenResult.data.token, {
        logLevel: 1,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        closeProtection: true,
      });

      wireDeviceLifecycle(device);
      deviceRef.current = device;
      setProblem('registering', 'Registrando softphone...');
      await registerDeviceWithTimeout(device, 'init_device');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'init_device_failed';
      setLastError(message);
      setProblem('degraded', `Error inicializando softphone: ${message}`);
      scheduleReconnect('init_exception', 4_000);
    } finally {
      initInFlightRef.current = false;
    }
  }, [clearReconnectTimer, scheduleReconnect, setProblem, softResetDevice, wireDeviceLifecycle]);

  useEffect(() => {
    initializeDeviceRef.current = initializeDevice;
  }, [initializeDevice]);

  useEffect(() => {
    if (!baseUrl || !accessToken) {
      enabledRef.current = false;
      clearReconnectTimer();
      softResetDevice();
      clearCalls();
      setIdentity('');
      setTokenExpired(false);
      setLastError(null);
      setDeviceStatus('disconnected');
      setDeviceReason('Sesion cerrada o backend no configurado');
      microphoneReadyRef.current = false;
      return;
    }

    enabledRef.current = true;
    void initializeDevice('session_ready');

    const healthInterval = setInterval(() => {
      if (!enabledRef.current) return;

      const device = deviceRef.current;
      if (!device) {
        setProblem('degraded', 'Softphone no inicializado');
        scheduleReconnect('missing_device_healthcheck', 1_500);
        return;
      }

      if (device.state === 'registering') {
        setProblem('registering', 'Softphone registrando...');
        return;
      }

      if (device.state !== 'registered') {
        setProblem('degraded', `Softphone en estado ${device.state}`);
        scheduleReconnect(`state_${device.state}`, 1_500);
        return;
      }

      if (deviceStatusRef.current !== 'connected') {
        setHealthy('Softphone operativo');
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    const onOnline = () => {
      void initializeDevice('browser_online');
    };

    const onOffline = () => {
      setProblem('degraded', 'Sin conectividad de red');
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      enabledRef.current = false;
      clearInterval(healthInterval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearReconnectTimer();
      softResetDevice();
      clearCalls();
      setDeviceStatus('disconnected');
      setDeviceReason('Motor de voz detenido');
    };
  }, [
    accessToken,
    baseUrl,
    clearCalls,
    clearReconnectTimer,
    initializeDevice,
    scheduleReconnect,
    setHealthy,
    setProblem,
    softResetDevice,
  ]);

  const isCallAttached = useCallback((callSid: string) => {
    return callsRef.current.has(callSid);
  }, []);

  const acceptCall = useCallback(async (callSid: string): Promise<VoiceActionResult> => {
    const managed = callsRef.current.get(callSid);
    if (!managed) {
      return { ok: false, error: 'No hay llamada entrante enlazada al softphone.' };
    }

    try {
      managed.call.accept();
      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'accept_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

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
      onCallMutedChanged?.(callSid, muted);
      return { ok: true, data: { call_sid: callSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'mute_toggle_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, [onCallMutedChanged]);

  const reconnectNow = useCallback(async () => {
    if (!enabledRef.current) return;
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    softResetDevice();
    await initializeDevice('manual');
  }, [clearReconnectTimer, initializeDevice, softResetDevice]);

  return useMemo(() => ({
    deviceStatus,
    deviceReason,
    identity,
    tokenExpired,
    lastError,
    attachedCallSids,
    acceptCall,
    disconnectCall,
    setMuted,
    isCallAttached,
    reconnectNow,
  }), [
    acceptCall,
    attachedCallSids,
    deviceReason,
    deviceStatus,
    disconnectCall,
    identity,
    isCallAttached,
    lastError,
    reconnectNow,
    setMuted,
    tokenExpired,
  ]);
}

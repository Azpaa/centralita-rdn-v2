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

const TOKEN_REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 20_000;
const DEVICE_ERROR_RETRY_DELAY_MS = 1_500;
// How long we wait for Twilio to assign a CallSid to a freshly connected
// outbound Call. If it still isn't available after this window we tear the
// call down instead of falling back to a synthetic SID (the synthetic SID
// masked real failures and left orphaned media legs alive).
const CALL_SID_RESOLUTION_TIMEOUT_MS = 3_500;
const CALL_SID_POLL_INTERVAL_MS = 50;

type VoiceActionResult = ApiResult<{
  call_sid: string;
}>;

type ManagedCall = {
  call: Call;
  // Canonical SID used by backend and all external control paths. For inbound
  // conference joins this is the PSTN parent CallSid supplied by the caller.
  // For outbound device.connect() it is the Twilio-assigned agent-leg SID.
  parentSid: string;
  // Twilio-assigned SID for the local media leg. For outbound this equals
  // parentSid (the outbound leg IS the canonical call). For inbound it is
  // different from parentSid (the agent's client leg joining the conference)
  // — we keep it only for logging; nothing external should depend on it.
  localSid: string;
  muted: boolean;
  direction: 'inbound' | 'outbound';
  destination: string | null;
  // True once the Twilio Call fired its 'accept' event (i.e. media is flowing).
  // Lets the UI show an accurate 'accepting' → 'connected' transition.
  accepted: boolean;
  // Wall-clock of when we wired the Call into the engine. Used by the App
  // to suppress the snapshot-orphan reaper during the window where backend
  // hasn't yet stamped `answered_by_user_id` on the call_record (Tauri's
  // device.connect path bypasses /agent-connect, so the stamp happens via
  // /accept/confirm which is a separate roundtrip).
  attachedAt: number;
};

type UseVoiceEngineParams = {
  baseUrl: string;
  accessToken: string;
  // All callbacks speak in parent/canonical SIDs (the one the backend uses).
  // The engine hides the local media-leg SID as an internal detail.
  onCallStarted?: (parentSid: string, direction: 'inbound' | 'outbound', destination: string | null) => void;
  onCallAccepted?: (parentSid: string) => void;
  onCallEnded?: (parentSid: string) => void;
  onCallMutedChanged?: (parentSid: string, muted: boolean) => void;
  onInfo?: (message: string) => void;
};

type UseVoiceEngineResult = {
  deviceStatus: VoiceDeviceStatus;
  deviceReason: string;
  identity: string;
  tokenExpired: boolean;
  lastError: string | null;
  // Parent SIDs of calls currently attached to the softphone (media path alive).
  attachedCallSids: string[];
  connectOutbound: (params: {
    destination: string;
    callerId: string;
    callRecordId?: string;
  }) => Promise<VoiceActionResult>;
  // parentCallSid is REQUIRED — Tauri must know the canonical SID up front.
  // It becomes the key used for later disconnect/mute operations.
  joinConference: (params: {
    conferenceName: string;
    parentCallSid: string;
  }) => Promise<VoiceActionResult>;
  // All action APIs are keyed by parent SID. Internally we translate to the
  // underlying Call reference, but callers never need to know about local SIDs.
  disconnectCall: (parentSid: string) => Promise<VoiceActionResult>;
  setMuted: (parentSid: string, muted: boolean) => Promise<VoiceActionResult>;
  isCallAttached: (parentSid: string) => boolean;
  isCallAccepted: (parentSid: string) => boolean;
  // Returns how many milliseconds ago the call was wired into the engine,
  // or null if the call isn't attached. Used to guard the orphan-cleanup
  // pass in applySnapshot from killing calls that backend hasn't yet
  // stamped as answered.
  getCallAttachedMsAgo: (parentSid: string) => number | null;
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
  const healthCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCallStartedRef = useRef(onCallStarted);
  const onCallAcceptedRef = useRef(onCallAccepted);
  const onCallEndedRef = useRef(onCallEnded);
  const onCallMutedChangedRef = useRef(onCallMutedChanged);
  const onInfoRef = useRef(onInfo);
  const deviceStatusRef = useRef<VoiceDeviceStatus>('disconnected');

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

  useEffect(() => {
    deviceStatusRef.current = deviceStatus;
  }, [deviceStatus]);

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

  const removeManagedCall = useCallback((parentSid: string) => {
    if (!callsRef.current.has(parentSid)) return;
    callsRef.current.delete(parentSid);
    syncAttachedCallSids();
    onCallEndedRef.current?.(parentSid);
  }, [syncAttachedCallSids]);

  const wireCallLifecycle = useCallback((
    call: Call,
    parentSid: string,
    localSid: string,
    direction: 'inbound' | 'outbound',
    destination: string | null,
  ) => {
    callsRef.current.set(parentSid, {
      call,
      parentSid,
      localSid,
      muted: false,
      direction,
      destination,
      accepted: false,
      attachedAt: Date.now(),
    });
    syncAttachedCallSids();

    call.on('accept', () => {
      const managed = callsRef.current.get(parentSid);
      if (managed) managed.accepted = true;
      onCallAcceptedRef.current?.(parentSid);
    });

    call.on('disconnect', () => {
      removeManagedCall(parentSid);
    });

    call.on('cancel', () => {
      removeManagedCall(parentSid);
    });

    call.on('reject', () => {
      removeManagedCall(parentSid);
    });

    call.on('error', (err: { message?: string }) => {
      const message = err.message || 'Error en llamada de voz';
      setLastError(message);
      onInfoRef.current?.(`Error de llamada ${parentSid}: ${message}`);
      removeManagedCall(parentSid);
    });
  }, [removeManagedCall, syncAttachedCallSids]);

  // Waits until Twilio assigns a CallSid to the Call (populated in
  // call.parameters.CallSid once the backend signals it) OR the call is
  // rejected/canceled/disconnected. Returns null on timeout — callers must
  // treat this as a fatal accept failure and tear down the Call. Previously
  // the engine synthesized `conf-${Date.now()}` / `outbound-${Date.now()}`
  // when Twilio hadn't populated CallSid yet, producing a ghost managed-call
  // that never matched real events.
  const waitForRealCallSid = useCallback((call: Call, timeoutMs: number): Promise<string | null> => {
    return new Promise((resolve) => {
      const existing = call.parameters?.CallSid;
      if (typeof existing === 'string' && existing.length > 0) {
        resolve(existing);
        return;
      }

      let resolved = false;
      const finish = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        clearInterval(poll);
        clearTimeout(timer);
        call.off('accept', onProgress);
        (call as unknown as { off: (event: string, fn: () => void) => void }).off('ringing', onProgress);
        call.off('disconnect', onFailure);
        call.off('cancel', onFailure);
        call.off('reject', onFailure);
        call.off('error', onFailure);
        resolve(value);
      };

      const checkNow = () => {
        const sid = call.parameters?.CallSid;
        if (typeof sid === 'string' && sid.length > 0) {
          finish(sid);
        }
      };
      const onProgress = () => checkNow();
      const onFailure = () => finish(null);

      const poll = setInterval(checkNow, CALL_SID_POLL_INTERVAL_MS);
      const timer = setTimeout(() => finish(null), timeoutMs);

      call.on('accept', onProgress);
      // `ringing` exists on the SDK at runtime even though its name isn't
      // in the public Call event union (varies between SDK versions).
      (call as unknown as { on: (event: string, fn: () => void) => void }).on('ringing', onProgress);
      call.on('disconnect', onFailure);
      call.on('cancel', onFailure);
      call.on('reject', onFailure);
      call.on('error', onFailure);
    });
  }, []);

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
        } catch (updateErr) {
          // If the token update throws AND there are active Calls, DO
          // NOT destroy the Device. Destroying would kill the Call and
          // tear down the conference (endConferenceOnExit). The Call
          // carries its own per-call JWT so it can outlive a bad Device
          // token update. Log and bail; the next refresh interval or
          // the health check will retry after the call ends.
          if (callsRef.current.size > 0) {
            const message = updateErr instanceof Error ? updateErr.message : 'token_update_failed';
            console.warn(
              `[voice-engine] updateToken failed mid-call (${message}); keeping existing Device alive until calls drain.`,
            );
            setHealthy('Token renovado tras fallo puntual (conservando llamada activa)');
            return deviceRef.current;
          }
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
        setProblem('degraded', `Error de softphone ${code}: ${message}`);
        onInfoRef.current?.(`Error de softphone ${code}: ${message}`);
        setTimeout(() => {
          if (!enabledRef.current || initInFlightRef.current) return;
          void ensureDevice('device_error_retry');
        }, DEVICE_ERROR_RETRY_DELAY_MS);
      });

      device.on('tokenWillExpire', async () => {
        setTokenExpired(true);
        onInfoRef.current?.('Token de voz proximo a expirar; refrescando');

        const refresh = await fetchVoiceToken(baseUrlRef.current, accessTokenRef.current);
        if (!refresh.ok) {
          setLastError(refresh.error);
          setProblem('degraded', `No se pudo refrescar token: ${refresh.error}`);
          setTimeout(() => {
            if (!enabledRef.current || initInFlightRef.current) return;
            void ensureDevice('token_refresh_retry');
          }, DEVICE_ERROR_RETRY_DELAY_MS);
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

  // Initialize device when session is ready.
  //
  // IMPORTANT: deps intentionally use `hasSession` (boolean) instead of the
  // raw `accessToken` string. Supabase auto-refreshes the access token every
  // ~55 min of a logged-in session — if we depended on the token string,
  // every refresh would re-run this effect, the cleanup would call
  // `device.destroy()`, the active Twilio Call would end, the agent leg
  // would leave the conference, and because the agent leg is wired with
  // `endConferenceOnExit: true` Twilio would tear down the WHOLE conference
  // (caller + RDN + Tauri drop simultaneously — exactly the "mid-call
  // everyone hangs up" symptom observed in production).
  //
  // With `hasSession` the effect only re-runs on login/logout, not on
  // token refreshes. `ensureDevice` already reads the latest token via
  // `accessTokenRef.current` and updates the Device with `updateToken`,
  // so token rotation stays transparent to the live call.
  const hasSession = Boolean(accessToken);
  useEffect(() => {
    if (!baseUrl || !hasSession) {
      enabledRef.current = false;
      if (tokenRefreshTimerRef.current) {
        clearInterval(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (healthCheckTimerRef.current) {
        clearInterval(healthCheckTimerRef.current);
        healthCheckTimerRef.current = null;
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

    healthCheckTimerRef.current = setInterval(() => {
      if (!enabledRef.current) return;
      if (initInFlightRef.current) return;
      if (deviceStatusRef.current === 'connected') return;
      void ensureDevice('health_check');
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => {
      enabledRef.current = false;
      if (tokenRefreshTimerRef.current) {
        clearInterval(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (healthCheckTimerRef.current) {
        clearInterval(healthCheckTimerRef.current);
        healthCheckTimerRef.current = null;
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
  }, [hasSession, baseUrl, ensureDevice, syncAttachedCallSids]);

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

      // Outbound: the Twilio-assigned CallSid IS the canonical/parent SID.
      // Wait for it instead of faking one — a synthetic SID would make the
      // backend and engine disagree on which call we're talking about.
      const realSid = await waitForRealCallSid(call, CALL_SID_RESOLUTION_TIMEOUT_MS);
      if (!realSid) {
        try { call.disconnect(); } catch { /* best-effort */ }
        const message = 'Twilio no asigno CallSid en el tiempo esperado; abortando llamada saliente.';
        setLastError(message);
        onInfoRef.current?.(message);
        return { ok: false, error: message };
      }

      wireCallLifecycle(call, realSid, realSid, 'outbound', connectParams.destination);
      onCallStartedRef.current?.(realSid, 'outbound', connectParams.destination);

      return { ok: true, data: { call_sid: realSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'connect_outbound_failed';
      setLastError(message);
      onInfoRef.current?.(`Error conectando llamada saliente: ${message}`);
      return { ok: false, error: message };
    }
  }, [ensureDevice, waitForRealCallSid, wireCallLifecycle]);

  const joinConference = useCallback(async (conferenceParams: {
    conferenceName: string;
    parentCallSid: string;
  }): Promise<VoiceActionResult> => {
    const parentSid = conferenceParams.parentCallSid;
    if (!parentSid || parentSid.length === 0) {
      return { ok: false, error: 'parentCallSid es obligatorio para unir el agente a la conferencia.' };
    }

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
          ParentCallSid: parentSid,
        },
      });

      // The agent-leg CallSid (local) differs from the parent (PSTN) SID.
      // We key everything by parent SID so external callers never need to
      // know or translate between them. The local SID is captured for logs
      // only; if Twilio doesn't supply one quickly the call is still usable
      // (disconnect/mute go through the Call reference, not the SID).
      const localSid = await waitForRealCallSid(call, CALL_SID_RESOLUTION_TIMEOUT_MS);
      const effectiveLocalSid = localSid ?? `pending-${parentSid}`;

      wireCallLifecycle(call, parentSid, effectiveLocalSid, 'inbound', null);
      onCallStartedRef.current?.(parentSid, 'inbound', null);

      return { ok: true, data: { call_sid: parentSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'join_conference_failed';
      setLastError(message);
      onInfoRef.current?.(`Error uniendose a conferencia: ${message}`);
      return { ok: false, error: message };
    }
  }, [ensureDevice, waitForRealCallSid, wireCallLifecycle]);

  const disconnectCall = useCallback(async (parentSid: string): Promise<VoiceActionResult> => {
    const managed = callsRef.current.get(parentSid);
    if (!managed) {
      return { ok: false, error: 'La llamada no esta enlazada localmente al softphone.' };
    }

    try {
      managed.call.disconnect();
      return { ok: true, data: { call_sid: parentSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'disconnect_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

  const setMuted = useCallback(async (parentSid: string, muted: boolean): Promise<VoiceActionResult> => {
    const managed = callsRef.current.get(parentSid);
    if (!managed) {
      return { ok: false, error: 'No hay media local para mutear/desmutear esta llamada.' };
    }

    try {
      managed.call.mute(muted);
      managed.muted = muted;
      onCallMutedChangedRef.current?.(parentSid, muted);
      return { ok: true, data: { call_sid: parentSid } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'mute_toggle_failed';
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

  const isCallAttached = useCallback((parentSid: string) => {
    return callsRef.current.has(parentSid);
  }, []);

  const isCallAccepted = useCallback((parentSid: string) => {
    return callsRef.current.get(parentSid)?.accepted === true;
  }, []);

  const getCallAttachedMsAgo = useCallback((parentSid: string) => {
    const managed = callsRef.current.get(parentSid);
    if (!managed) return null;
    return Date.now() - managed.attachedAt;
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

    // Guard: never tear down the Device while there are active Calls.
    // `device.destroy()` disconnects every Call it owns, and the agent
    // leg is wired with `endConferenceOnExit: true` so dropping it also
    // kills the remote caller and RDN. Wake-gap detection and
    // recoverRealtime both call reconnectNow; with a background Tauri
    // window WebView2 throttles timers enough to trigger wake-gap
    // spuriously mid-call, and this guard is what keeps that from
    // collapsing the whole conference.
    if (callsRef.current.size > 0) {
      onInfoRef.current?.(
        `Reinicio del motor pospuesto: hay ${callsRef.current.size} llamada(s) activa(s). Se procesara al colgar.`,
      );
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
    isCallAccepted,
    getCallAttachedMsAgo,
    reconnectNow,
  }), [
    attachedCallSids,
    connectOutbound,
    deviceReason,
    deviceStatus,
    disconnectCall,
    getCallAttachedMsAgo,
    identity,
    isCallAccepted,
    isCallAttached,
    joinConference,
    lastError,
    reconnectNow,
    setMuted,
    tokenExpired,
  ]);
}

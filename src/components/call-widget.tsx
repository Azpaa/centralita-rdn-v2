'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PhoneIncoming,
  PhoneOutgoing,
  PhoneOff,
  Phone,
  Mic,
  MicOff,
  Keyboard,
  X,
  Loader2,
  Wifi,
  WifiOff,
  PhoneForwarded,
  UserPlus,
  Users,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCall } from '@/contexts/call-context';
import type { CallRecord, PhoneNumber, User } from '@/lib/types/database';

// ─── Types ───────────────────────────────────────────────────────────────────

type WidgetState = 'idle' | 'connecting' | 'incoming' | 'active' | 'disconnected';
type SoftphoneStatus = 'connected' | 'reconnecting' | 'degraded' | 'disconnected' | 'needs_intervention';

type CallSlot = {
  id: string;
  call: Call;
  number: string;
  direction: 'inbound' | 'outbound';
  state: 'connecting' | 'active';
  elapsed: number;
  muted: boolean;
  /** Twilio Call SID for server-side operations */
  callSid: string;
};

type TransferTarget = {
  type: 'user' | 'number';
  id?: string;
  name: string;
  destination: string;
};

type OverlayMode = 'none' | 'transfer' | 'consult' | 'dialpad' | 'conference-actions';

// ─── Component ───────────────────────────────────────────────────────────────

export function CallWidget() {
  const deviceRef = useRef<Device | null>(null);

  // Global state
  const [widgetState, setWidgetState] = useState<WidgetState>('idle');
  const [registered, setRegistered] = useState(false);
  const [softphoneStatus, setSoftphoneStatus] = useState<SoftphoneStatus>('reconnecting');
  const [softphoneReason, setSoftphoneReason] = useState('Inicializando...');
  const [error, setError] = useState('');
  const [identity, setIdentity] = useState('');

  // Call slots — supports multiple simultaneous calls
  const [calls, setCalls] = useState<CallSlot[]>([]);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Incoming call (not yet accepted)
  const incomingCallRef = useRef<Call | null>(null);
  const [incomingInfo, setIncomingInfo] = useState('');

  // Overlay / action panels
  const [overlay, setOverlay] = useState<OverlayMode>('none');
  const [showNewCallDialpad, setShowNewCallDialpad] = useState(false);

  // Dial state
  const [dialNumber, setDialNumber] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [activeNumbers, setActiveNumbers] = useState<PhoneNumber[]>([]);

  // Transfer state
  const [transferSearch, setTransferSearch] = useState('');
  const [transferNumber, setTransferNumber] = useState('');
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [transferMode, setTransferMode] = useState<'users' | 'number'>('users');

  // Conference state
  const [conferenceName, setConferenceName] = useState<string | null>(null);

  // Context
  const { registerDialHandler } = useCall();

  // Stable refs for callbacks that need latest state
  const callsRef = useRef<CallSlot[]>([]);
  callsRef.current = calls;
  const activeCallIdRef = useRef<string | null>(null);
  activeCallIdRef.current = activeCallId;
  const reconnectingRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthCheckInFlightRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const initDeviceRef = useRef<(() => Promise<void>) | null>(null);
  const lastHealthyAtRef = useRef(0);
  const consecutiveInitFailuresRef = useRef(0);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const getActiveCall = useCallback((): CallSlot | undefined => {
    return callsRef.current.find(c => c.id === activeCallIdRef.current);
  }, []);

  const genId = () => Math.random().toString(36).slice(2, 8);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // ─── Timer management ──────────────────────────────────────────────────────

  const startTimer = useCallback((callId: string) => {
    if (timersRef.current.has(callId)) return;
    const interval = setInterval(() => {
      setCalls(prev => prev.map(c =>
        c.id === callId ? { ...c, elapsed: c.elapsed + 1 } : c
      ));
    }, 1000);
    timersRef.current.set(callId, interval);
  }, []);

  const stopTimer = useCallback((callId: string) => {
    const interval = timersRef.current.get(callId);
    if (interval) {
      clearInterval(interval);
      timersRef.current.delete(callId);
    }
  }, []);

  const stopAllTimers = useCallback(() => {
    timersRef.current.forEach(interval => clearInterval(interval));
    timersRef.current.clear();
  }, []);

  // ─── Call slot management ──────────────────────────────────────────────────

  const removeCallSlot = useCallback((callId: string) => {
    stopTimer(callId);
    setCalls(prev => {
      const remaining = prev.filter(c => c.id !== callId);
      // If the active call was removed, switch to another
      setActiveCallId(currentActive => {
        if (currentActive === callId) {
          return remaining.length > 0 ? remaining[0].id : null;
        }
        return currentActive;
      });
      if (remaining.length === 0) {
        setWidgetState('idle');
        setOverlay('none');
        setConferenceName(null);
      }
      // Auto-unmute: if exactly one call remains and it's muted,
      // unmute it so the agent isn't left in silent mode
      if (remaining.length === 1 && remaining[0].muted) {
        remaining[0].call.mute(false);
        remaining[0] = { ...remaining[0], muted: false };
      }
      return remaining;
    });
  }, [stopTimer]);

  const updateCallSlot = useCallback((callId: string, updates: Partial<CallSlot>) => {
    setCalls(prev => prev.map(c => c.id === callId ? { ...c, ...updates } : c));
  }, []);

  const addCallSlot = useCallback((call: Call, number: string, direction: 'inbound' | 'outbound'): string => {
    const id = genId();
    const slot: CallSlot = {
      id,
      call,
      number,
      direction,
      state: 'connecting',
      elapsed: 0,
      muted: false,
      callSid: '',
    };
    setCalls(prev => [...prev, slot]);
    setActiveCallId(id);
    return id;
  }, []);

  const cleanup = useCallback(() => {
    setCalls([]);
    setActiveCallId(null);
    setWidgetState('idle');
    setOverlay('none');
    setConferenceName(null);
    stopAllTimers();
    incomingCallRef.current = null;
    setIncomingInfo('');
  }, [stopAllTimers]);

  const lookupRdnOutboundBySid = useCallback(async (callSid: string, currentIdentity: string) => {
    if (!callSid) return null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const params = new URLSearchParams();
      params.set('twilio_call_sid', callSid);
      params.set('page', '1');
      params.set('limit', '1');

      const res = await api.get<CallRecord[]>(`/calls?${params.toString()}`);
      if (!res.ok || res.data.length === 0) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        return null;
      }

      const record = res.data[0];
      const source = typeof record.twilio_data?.source === 'string'
        ? record.twilio_data.source
        : '';

      const isRdnOutbound = record.direction === 'outbound'
        && (
          source === 'rdn'
          || source === 'rdn_adopted'
          || source === 'rdn_adopted_browser'
        );

      if (!isRdnOutbound) return null;
      if (record.answered_by_user_id && record.answered_by_user_id !== currentIdentity) return null;

      return record;
    }

    return null;
  }, []);

  // ─── Setup call event handlers ─────────────────────────────────────────────

  const setupCallHandlers = useCallback((call: Call, callId: string) => {
    call.on('accept', () => {
      console.log('[CallWidget] Call accepted, callId:', callId);
      const sid = call.parameters?.CallSid || '';
      updateCallSlot(callId, { state: 'active', callSid: sid });
      setWidgetState('active');
      startTimer(callId);
    });

    call.on('disconnect', () => {
      console.log('[CallWidget] Call disconnected, callId:', callId);
      removeCallSlot(callId);
    });

    call.on('cancel', () => {
      console.log('[CallWidget] Call canceled, callId:', callId);
      removeCallSlot(callId);
    });

    call.on('reject', () => {
      removeCallSlot(callId);
    });

    call.on('error', (err: { message?: string }) => {
      console.error('[CallWidget] Call error:', err);
      setError(err.message || 'Error en la llamada');
      removeCallSlot(callId);
    });
  }, [updateCallSlot, removeCallSlot, startTimer]);

  // ─── Initialize Twilio Device ──────────────────────────────────────────────

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const markSoftphoneHealthy = useCallback((reason: string) => {
    setRegistered(true);
    setSoftphoneStatus('connected');
    setSoftphoneReason(reason);
    setError('');
    lastHealthyAtRef.current = Date.now();
    reconnectAttemptRef.current = 0;
    consecutiveInitFailuresRef.current = 0;
    clearReconnectTimer();
    reconnectingRef.current = false;
  }, [clearReconnectTimer]);

  const markSoftphoneProblem = useCallback((status: Exclude<SoftphoneStatus, 'connected'>, reason: string) => {
    setRegistered(false);
    setSoftphoneStatus(status);
    setSoftphoneReason(reason);
  }, []);

  const scheduleReconnect = useCallback((reason: string, delayMs?: number) => {
    if (reconnectTimerRef.current) return;

    reconnectAttemptRef.current += 1;
    const computedDelay = delayMs ?? Math.min(20_000, 1_000 * 2 ** Math.min(reconnectAttemptRef.current, 4));
    markSoftphoneProblem('reconnecting', reason);

    console.warn(
      `[CallWidget] Scheduling reconnect in ${Math.round(computedDelay / 1000)}s. reason=${reason} attempt=${reconnectAttemptRef.current}`
    );

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectingRef.current = false;
      const runInit = initDeviceRef.current;
      if (runInit) void runInit();
    }, computedDelay);
  }, [markSoftphoneProblem]);

  const initDevice = useCallback(async () => {
    if (reconnectingRef.current) return; // prevent parallel reconnect attempts
    reconnectingRef.current = true;
    clearReconnectTimer();
    markSoftphoneProblem('reconnecting', 'Inicializando softphone');

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      markSoftphoneProblem('degraded', 'Sin conectividad de red');
      reconnectingRef.current = false;
      return;
    }

    try {
      setError('');
      const res = await api.get<{ token: string; identity: string; userName: string }>('/token');
      if (!res.ok) {
        const message = res.error || 'Error obteniendo token de voz';
        setError(message);
        consecutiveInitFailuresRef.current += 1;

        if (consecutiveInitFailuresRef.current >= 3) {
          markSoftphoneProblem('needs_intervention', 'No se pudo renovar el token de voz. Reintenta o revisa la sesion.');
          reconnectingRef.current = false;
          return;
        }

        markSoftphoneProblem('degraded', 'No se pudo obtener token de voz');
        reconnectingRef.current = false;
        scheduleReconnect('token_fetch_failed');
        return;
      }

      const { token, identity: id } = res.data;
      setIdentity(id);

      if (deviceRef.current) {
        // Try to just update the token if the device exists and is usable
        try {
          deviceRef.current.updateToken(token);
          await deviceRef.current.register();
          markSoftphoneHealthy('Registro renovado');
          return;
        } catch {
          // Device is in bad state: destroy and recreate
          try {
            deviceRef.current.destroy();
          } catch {
            // no-op
          }
          deviceRef.current = null;
        }
      }

      const device = new Device(token, {
        logLevel: 1,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        // Keep the WebSocket alive even when not in a call
        closeProtection: true,
      });

      device.on('registering', () => {
        markSoftphoneProblem('reconnecting', 'Registrando softphone');
        console.log('[CallWidget] Device registering...');
      });

      device.on('registered', () => {
        console.log('[CallWidget] Device registered');
        markSoftphoneHealthy('Softphone registrado');
      });

      device.on('unregistered', () => {
        console.warn('[CallWidget] Device unregistered');
        markSoftphoneProblem('degraded', 'Softphone desregistrado');
        scheduleReconnect('device_unregistered', 2500);
      });

      device.on('destroyed', () => {
        console.warn('[CallWidget] Device destroyed');
        markSoftphoneProblem('degraded', 'Softphone destruido');
        scheduleReconnect('device_destroyed', 2500);
      });

      device.on('error', (err: { message?: string; code?: number }) => {
        const code = err.code;
        const reason = `device_error_${String(code ?? 'unknown')}`;
        console.error('[CallWidget] Device error:', err);

        // Token/transport-related errors
        if (code === 31204 || code === 31205 || code === 31009) {
          markSoftphoneProblem('degraded', 'Error de token o transporte en softphone');
          scheduleReconnect(reason, 2000);
          return;
        }

        setError(err.message || 'Error de dispositivo');
        markSoftphoneProblem('degraded', err.message || 'Error de dispositivo');
      });

      device.on('incoming', (call: Call) => {
        const currentIdentity = id;
        const incomingSid = call.parameters?.CallSid || '';

        void (async () => {
          try {
            const outboundRecord = await lookupRdnOutboundBySid(incomingSid, currentIdentity);
            if (outboundRecord) {
              console.log(
                `[CallWidget] Auto-adopting RDN outbound CallSid=${incomingSid} to=${outboundRecord.to_number} (no inbound acceptance UX)`
              );
              const callId = addCallSlot(call, outboundRecord.to_number, 'outbound');
              setupCallHandlers(call, callId);
              call.accept();
              incomingCallRef.current = null;
              setIncomingInfo('');
              setWidgetState('active');
              return;
            }
          } catch (err) {
            console.warn('[CallWidget] Failed to lookup outgoing adoption context, fallback to normal incoming UI', err);
          }

          console.log('[CallWidget] Incoming call from:', call.parameters.From);
          incomingCallRef.current = call;
          setIncomingInfo(call.parameters.From || 'Desconocido');
          setWidgetState('incoming');

          // Bring attention to the tab if in background
          if (document.hidden) {
            try {
              // Try to show a notification
              if (Notification.permission === 'granted') {
                new Notification('Llamada entrante', {
                  body: `De: ${call.parameters.From || 'Desconocido'}`,
                  icon: '/favicon.ico',
                  tag: 'incoming-call',
                  requireInteraction: true,
                });
              }
            } catch { /* notifications not supported */ }
          }
        })();
      });

      device.on('tokenWillExpire', async () => {
        console.log('[CallWidget] Token expiring, refreshing...');
        try {
          const refreshRes = await api.get<{ token: string }>('/token');
          if (refreshRes.ok) {
            device.updateToken(refreshRes.data.token);
            console.log('[CallWidget] Token refreshed');
          } else {
            markSoftphoneProblem('degraded', 'No se pudo refrescar el token de voz');
            scheduleReconnect('token_refresh_failed', 2000);
          }
        } catch {
          markSoftphoneProblem('degraded', 'Error refrescando token de voz');
          scheduleReconnect('token_refresh_exception', 2000);
        }
      });

      deviceRef.current = device;
      await device.register();
    } catch (err) {
      console.error('[CallWidget] Init error:', err);
      setError('Error inicializando dispositivo de voz');
      consecutiveInitFailuresRef.current += 1;

      if (consecutiveInitFailuresRef.current >= 3) {
        markSoftphoneProblem('needs_intervention', 'No se pudo levantar el softphone tras varios intentos.');
      } else {
        markSoftphoneProblem('degraded', 'Error inicializando softphone');
        scheduleReconnect('init_exception', 5000);
      }
    } finally {
      reconnectingRef.current = false;
    }
  }, [addCallSlot, clearReconnectTimer, lookupRdnOutboundBySid, markSoftphoneHealthy, markSoftphoneProblem, scheduleReconnect, setupCallHandlers]);
  useEffect(() => {
    initDeviceRef.current = initDevice;
  }, [initDevice]);

  const runSoftphoneHealthCheck = useCallback(async (trigger: string, forceRegister = false) => {
    if (healthCheckInFlightRef.current) return;
    healthCheckInFlightRef.current = true;

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        markSoftphoneProblem('degraded', 'Sin conectividad de red');
        return;
      }

      const device = deviceRef.current;
      if (!device) {
        markSoftphoneProblem('degraded', `Softphone no inicializado (${trigger})`);
        scheduleReconnect(`missing_device_${trigger}`, 1200);
        return;
      }

      if (device.state !== 'registered') {
        markSoftphoneProblem('degraded', `Softphone ${device.state} (${trigger})`);
        scheduleReconnect(`state_${device.state}_${trigger}`, 1200);
        return;
      }

      const staleMs = Date.now() - lastHealthyAtRef.current;
      const shouldReRegister = forceRegister || (staleMs > 7 * 60 * 1000);
      if (shouldReRegister && callsRef.current.length === 0) {
        console.log(
          `[CallWidget] Health check (${trigger}) forcing register refresh. staleMs=${staleMs}`
        );

        try {
          await device.register();
          markSoftphoneHealthy(`Registro validado (${trigger})`);
        } catch (err) {
          console.warn(`[CallWidget] Health check register failed (${trigger})`, err);
          markSoftphoneProblem('degraded', `Fallo al re-registrar (${trigger})`);
          scheduleReconnect(`register_refresh_failed_${trigger}`, 1500);
        }
        return;
      }

      if (softphoneStatus !== 'connected') {
        markSoftphoneHealthy(`Salud OK (${trigger})`);
      } else {
        lastHealthyAtRef.current = Date.now();
      }
    } finally {
      healthCheckInFlightRef.current = false;
    }
  }, [markSoftphoneHealthy, markSoftphoneProblem, scheduleReconnect, softphoneStatus]);

  // ─── Mute helpers ──────────────────────────────────────────────────────────

  const muteCall = useCallback((callId: string) => {
    const slot = callsRef.current.find(c => c.id === callId);
    if (!slot) return;
    slot.call.mute(true);
    updateCallSlot(callId, { muted: true });
  }, [updateCallSlot]);

  const unmuteCall = useCallback((callId: string) => {
    const slot = callsRef.current.find(c => c.id === callId);
    if (!slot) return;
    slot.call.mute(false);
    updateCallSlot(callId, { muted: false });
  }, [updateCallSlot]);

  // ─── Call actions ──────────────────────────────────────────────────────────

  const answerCall = useCallback(() => {
    const call = incomingCallRef.current;
    if (!call) return;
    const callId = addCallSlot(call, call.parameters.From || 'Desconocido', 'inbound');
    setupCallHandlers(call, callId);
    call.accept();
    incomingCallRef.current = null;
    setIncomingInfo('');
    setWidgetState('active');
  }, [addCallSlot, setupCallHandlers]);

  const rejectCall = useCallback(() => {
    incomingCallRef.current?.reject();
    incomingCallRef.current = null;
    setIncomingInfo('');
    if (callsRef.current.length === 0) setWidgetState('idle');
    else setWidgetState('active');
  }, []);

  const hangupCall = useCallback((callId: string) => {
    const slot = callsRef.current.find(c => c.id === callId);
    if (slot) slot.call.disconnect();
    removeCallSlot(callId);
  }, [removeCallSlot]);

  const toggleMute = useCallback((callId: string) => {
    setCalls(prev => prev.map(c => {
      if (c.id === callId) {
        const newMuted = !c.muted;
        c.call.mute(newMuted);
        return { ...c, muted: newMuted };
      }
      return c;
    }));
  }, []);

  const sendDtmf = useCallback((digit: string) => {
    const slot = getActiveCall();
    if (slot) slot.call.sendDigits(digit);
  }, [getActiveCall]);

  // ─── Make outbound call ────────────────────────────────────────────────────

  const makeOutboundCall = useCallback(async (number: string, from?: string) => {
    if (!deviceRef.current) {
      setError('Dispositivo de voz no conectado.');
      return;
    }

    let formattedNumber = number.trim();
    // Don't prefix client: destinations
    if (!formattedNumber.startsWith('client:') && !formattedNumber.startsWith('+')) {
      formattedNumber = `+34${formattedNumber}`;
    }

    const callerIdToUse = from || fromNumber;

    // If there's an active call, mute it while we dial the new one
    const currentActive = callsRef.current.find(c => c.state === 'active');
    if (currentActive) {
      muteCall(currentActive.id);
    }

    setWidgetState('active');
    setOverlay('none');

    try {
      const call = await deviceRef.current.connect({
        params: {
          To: formattedNumber,
          CallerId: callerIdToUse,
          UserId: identity,
        },
      });

      const callId = addCallSlot(call, formattedNumber, 'outbound');
      setupCallHandlers(call, callId);
      setShowNewCallDialpad(false);
      setDialNumber('');
    } catch (err) {
      console.error('[CallWidget] Dial error:', err);
      setError('Error al iniciar llamada');
    }
  }, [fromNumber, identity, addCallSlot, setupCallHandlers, muteCall]);

  // ─── Transfer (cold) ──────────────────────────────────────────────────────

  const transferCall = useCallback(async (target: TransferTarget) => {
    const slot = getActiveCall();
    if (!slot || !slot.callSid) {
      setError('No hay llamada activa para transferir');
      return;
    }

    try {
      await api.post('/calls/transfer', {
        callSid: slot.callSid,
        destination: target.destination,
        callerId: fromNumber,
      });

      // El servidor ya redirigió la llamada remota y completó nuestra leg
      // vía REST API. Desconectamos también el objeto Call del SDK para
      // limpiar el estado local de forma inmediata (el evento 'disconnect'
      // eliminará el slot del widget).
      try {
        slot.call.disconnect();
      } catch {
        // Ya desconectada — OK
      }

      setOverlay('none');
    } catch {
      setError('Error al transferir la llamada');
    }
  }, [getActiveCall, fromNumber]);

  // ─── Conference / 3-way ────────────────────────────────────────────────────

  const mergeCallsToConference = useCallback(async () => {
    const currentCalls = callsRef.current;
    if (currentCalls.length < 2) {
      setError('Se necesitan al menos 2 llamadas para unir');
      return;
    }

    const name = `conf-${Date.now()}-${genId()}`;
    setConferenceName(name);

    try {
      // Move all calls to the conference
      for (const slot of currentCalls) {
        if (slot.callSid) {
          await api.post('/calls/conference', {
            action: 'create',
            conferenceName: name,
            callSid: slot.callSid,
          });
        }
      }
      setOverlay('none');
    } catch {
      setError('Error al unir llamadas en conferencia');
    }
  }, []);

  const leaveConference = useCallback(async () => {
    if (!conferenceName) return;

    try {
      // The agent disconnects from all their calls
      // The other parties stay connected in the conference
      for (const slot of callsRef.current) {
        slot.call.disconnect();
      }
      cleanup();
    } catch {
      setError('Error al salir de la conferencia');
    }
  }, [conferenceName, cleanup]);

  // ─── Load users for transfer ───────────────────────────────────────────────

  const loadAvailableUsers = useCallback(async () => {
    const res = await api.get<User[]>('/users?limit=100');
    if (res.ok) {
      setAvailableUsers(res.data.filter(u => u.active && u.id !== identity));
    }
  }, [identity]);

  // ─── External dial (from other components via CallContext) ─────────────────

  const externalDial = useCallback(async (number: string, from?: string) => {
    await makeOutboundCall(number, from);
  }, [makeOutboundCall]);

  useEffect(() => {
    registerDialHandler(externalDial);
  }, [registerDialHandler, externalDial]);

  // ─── Load phone numbers ────────────────────────────────────────────────────

  useEffect(() => {
    api.get<PhoneNumber[]>('/phone-numbers?limit=100').then((res) => {
      if (res.ok) {
        const active = res.data.filter((n) => n.active);
        setActiveNumbers(active);
        if (active.length > 0 && !fromNumber) {
          setFromNumber(active[0].phone_number);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Initialize device on mount ────────────────────────────────────────────

  useEffect(() => {
    initDevice();

    // Request notification permission for incoming calls when tab is in background
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // DO NOT destroy the device on cleanup: the widget should stay alive
    // as long as the app is open. Only clean up timers/reconnect scheduler.
    return () => {
      stopAllTimers();
      clearReconnectTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Visibility change: re-check device when tab regains focus ─────────────

  useEffect(() => {
    const onTabVisible = () => {
      if (document.visibilityState !== 'visible') return;
      console.log('[CallWidget] Tab visible: checking softphone health');
      void runSoftphoneHealthCheck('tab_visible', true);
    };

    const onFocus = () => {
      console.log('[CallWidget] Window focus: checking softphone health');
      void runSoftphoneHealthCheck('window_focus', true);
    };

    const onPageShow = () => {
      console.log('[CallWidget] Page shown: checking softphone health');
      void runSoftphoneHealthCheck('pageshow', true);
    };

    document.addEventListener('visibilitychange', onTabVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      document.removeEventListener('visibilitychange', onTabVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [runSoftphoneHealthCheck]);

  useEffect(() => {
    const onOnline = () => {
      console.log('[CallWidget] Browser online: scheduling health check');
      void runSoftphoneHealthCheck('browser_online', true);
    };

    const onOffline = () => {
      console.warn('[CallWidget] Browser offline: softphone degraded');
      markSoftphoneProblem('degraded', 'Navegador sin conexion');
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [markSoftphoneProblem, runSoftphoneHealthCheck]);

  // ─── Keepalive: periodic check even in background ──────────────────────────
  // Browsers throttle timers heavily in background tabs.
  // Keepalive periodically validates the registration and forces recovery if needed.
  // This is a lightweight safety net, not a voice heartbeat stream.

  useEffect(() => {
    const KEEPALIVE_INTERVAL = 90 * 1000; // 90 seconds (background tabs are throttled by the browser)

    const interval = setInterval(() => {
      const forceRegister = document.visibilityState === 'visible';
      void runSoftphoneHealthCheck('interval_keepalive', forceRegister);
    }, KEEPALIVE_INTERVAL);

    return () => clearInterval(interval);
  }, [runSoftphoneHealthCheck]);

  // ─── Compute derived state ─────────────────────────────────────────────────

  const activeCall = calls.find(c => c.id === activeCallId);
  const hasMultipleCalls = calls.length > 1;
  const canDial = softphoneStatus === 'connected' && registered;

  const softphoneBadgeClass = softphoneStatus === 'connected'
    ? 'bg-green-500/10 text-green-600 border-green-500/30'
    : softphoneStatus === 'reconnecting'
      ? 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30'
      : softphoneStatus === 'degraded'
        ? 'bg-amber-500/10 text-amber-700 border-amber-500/30'
        : softphoneStatus === 'needs_intervention'
          ? 'bg-destructive/10 text-destructive border-destructive/40'
          : 'bg-muted text-muted-foreground border-border';

  const softphoneBadgeLabel = softphoneStatus === 'connected'
    ? 'Conectado'
    : softphoneStatus === 'reconnecting'
      ? 'Reconectando...'
      : softphoneStatus === 'degraded'
        ? 'Degradado'
        : softphoneStatus === 'needs_intervention'
          ? 'Revisar sesion'
          : 'Desconectado';

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {/* Error toast */}
      {error && (
        <div className="w-80 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="hover:opacity-70">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ── Incoming call alert ── */}
      {widgetState === 'incoming' && (
        <div className="w-80 animate-pulse rounded-xl border border-green-500/50 bg-card p-4 shadow-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/20">
              <PhoneIncoming className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-sm font-semibold">Llamada entrante</p>
              <p className="text-xs text-muted-foreground">{incomingInfo}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={answerCall}>
              <Phone className="mr-1 h-4 w-4" /> Contestar
            </Button>
            <Button size="sm" variant="destructive" className="flex-1" onClick={rejectCall}>
              <PhoneOff className="mr-1 h-4 w-4" /> Rechazar
            </Button>
          </div>
        </div>
      )}

      {/* ── Other calls (when multiple active) ── */}
      {calls.filter(c => c.id !== activeCallId).map((slot) => (
        <div key={slot.id} className="w-80 rounded-xl border border-muted-foreground/30 bg-card/80 p-3 shadow-lg">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              {slot.muted ? <MicOff className="h-4 w-4 text-muted-foreground" /> : <Mic className="h-4 w-4 text-muted-foreground" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{slot.muted ? 'Silenciada' : 'En llamada'}</p>
              <p className="text-xs text-muted-foreground truncate">{slot.number}</p>
            </div>
            <span className="text-xs font-mono text-muted-foreground">{formatTime(slot.elapsed)}</span>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => {
                  // Switch to this call as active
                  const currentActive = callsRef.current.find(c => c.id === activeCallId);
                  if (currentActive) muteCall(currentActive.id);
                  unmuteCall(slot.id);
                  setActiveCallId(slot.id);
                }}
                title="Retomar"
              >
                <Phone className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="destructive"
                className="h-7 w-7"
                onClick={() => hangupCall(slot.id)}
                title="Colgar"
              >
                <PhoneOff className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      ))}

      {/* ── Active call card ── */}
      {widgetState === 'active' && activeCall && (
        <div className="w-80 rounded-xl border bg-card p-4 shadow-2xl">
          {/* Header */}
          <div className="flex items-center gap-3 mb-3">
            <div className={cn(
              'flex h-10 w-10 items-center justify-center rounded-full',
              activeCall.state === 'connecting' ? 'bg-yellow-500/20' :
                conferenceName ? 'bg-blue-500/20' : 'bg-green-500/20'
            )}>
              {activeCall.state === 'connecting' ? (
                <Loader2 className="h-5 w-5 text-yellow-500 animate-spin" />
              ) : conferenceName ? (
                <Users className="h-5 w-5 text-blue-500" />
              ) : activeCall.direction === 'outbound' ? (
                <PhoneOutgoing className="h-5 w-5 text-green-500" />
              ) : (
                <PhoneIncoming className="h-5 w-5 text-green-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">
                {activeCall.state === 'connecting' ? 'Conectando...' :
                  conferenceName ? 'Conferencia' : 'En llamada'}
              </p>
              <p className="text-xs text-muted-foreground truncate">{activeCall.number}</p>
            </div>
            {activeCall.state === 'active' && (
              <span className="text-xs font-mono text-muted-foreground">
                {formatTime(activeCall.elapsed)}
              </span>
            )}
          </div>

          {/* Conference badge */}
          {conferenceName && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1.5">
              <Users className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-xs text-blue-600 font-medium">
                Conferencia a {calls.length} vías
              </span>
            </div>
          )}

          {/* In-call DTMF pad */}
          {overlay === 'dialpad' && (
            <div className="mb-3 grid grid-cols-3 gap-1">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(d => (
                <button
                  key={d}
                  onClick={() => sendDtmf(d)}
                  className="rounded-md border bg-muted/50 py-2 text-sm font-medium hover:bg-muted transition-colors"
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          {/* Transfer overlay */}
          {overlay === 'transfer' && (
            <div className="mb-3 rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold">Transferir llamada</h4>
                <button onClick={() => setOverlay('none')} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex gap-1">
                <button
                  onClick={() => { setTransferMode('users'); loadAvailableUsers(); }}
                  className={cn('flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    transferMode === 'users' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  Usuarios
                </button>
                <button
                  onClick={() => setTransferMode('number')}
                  className={cn('flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    transferMode === 'number' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  Número
                </button>
              </div>

              {transferMode === 'users' ? (
                <div className="space-y-1.5">
                  <Input
                    placeholder="Buscar usuario..."
                    value={transferSearch}
                    onChange={(e) => setTransferSearch(e.target.value)}
                    className="h-7 text-xs"
                  />
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {availableUsers
                      .filter(u =>
                        u.name.toLowerCase().includes(transferSearch.toLowerCase()) ||
                        u.email.toLowerCase().includes(transferSearch.toLowerCase())
                      )
                      .map(user => (
                        <button
                          key={user.id}
                          onClick={() => transferCall({
                            type: 'user',
                            id: user.id,
                            name: user.name,
                            destination: `client:${user.id}`,
                          })}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                        >
                          <div className={cn(
                            'h-2 w-2 rounded-full',
                            user.available ? 'bg-green-500' : 'bg-gray-300'
                          )} />
                          <span className="font-medium truncate">{user.name}</span>
                          {user.phone && (
                            <span className="text-muted-foreground ml-auto text-[10px]">{user.phone}</span>
                          )}
                        </button>
                      ))
                    }
                    {availableUsers.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">Sin usuarios</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex gap-1">
                  <Input
                    placeholder="612345678"
                    value={transferNumber}
                    onChange={(e) => setTransferNumber(e.target.value)}
                    className="h-7 text-xs font-mono flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && transferNumber.trim()) {
                        let num = transferNumber.trim();
                        if (!num.startsWith('+')) num = `+34${num}`;
                        transferCall({ type: 'number', name: num, destination: num });
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!transferNumber.trim()}
                    onClick={() => {
                      let num = transferNumber.trim();
                      if (!num.startsWith('+')) num = `+34${num}`;
                      transferCall({ type: 'number', name: num, destination: num });
                    }}
                  >
                    <PhoneForwarded className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Consult call overlay — dial a second person */}
          {overlay === 'consult' && (
            <div className="mb-3 rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold">Llamar a otra persona</h4>
                <button onClick={() => setOverlay('none')} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </div>

              <div className="flex gap-1">
                <button
                  onClick={() => { setTransferMode('users'); loadAvailableUsers(); }}
                  className={cn('flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    transferMode === 'users' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  Usuarios
                </button>
                <button
                  onClick={() => setTransferMode('number')}
                  className={cn('flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    transferMode === 'number' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                  )}
                >
                  Número
                </button>
              </div>

              {transferMode === 'users' ? (
                <div className="space-y-1.5">
                  <Input
                    placeholder="Buscar usuario..."
                    value={transferSearch}
                    onChange={(e) => setTransferSearch(e.target.value)}
                    className="h-7 text-xs"
                  />
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {availableUsers
                      .filter(u =>
                        u.name.toLowerCase().includes(transferSearch.toLowerCase()) ||
                        u.email.toLowerCase().includes(transferSearch.toLowerCase())
                      )
                      .map(user => (
                        <button
                          key={user.id}
                          onClick={() => {
                            // Dial this user as a second call (hold current first)
                            makeOutboundCall(`client:${user.id}`);
                          }}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                        >
                          <div className={cn(
                            'h-2 w-2 rounded-full',
                            user.available ? 'bg-green-500' : 'bg-gray-300'
                          )} />
                          <span className="font-medium truncate">{user.name}</span>
                        </button>
                      ))
                    }
                  </div>
                </div>
              ) : (
                <div className="flex gap-1">
                  <Input
                    placeholder="612345678"
                    value={dialNumber}
                    onChange={(e) => setDialNumber(e.target.value)}
                    className="h-7 text-xs font-mono flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && dialNumber.trim()) {
                        makeOutboundCall(dialNumber);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!dialNumber.trim()}
                    onClick={() => makeOutboundCall(dialNumber)}
                  >
                    <Phone className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Main action buttons */}
          {activeCall.state === 'active' && (
            <div className="space-y-2">
              {/* Primary controls */}
              <div className="flex items-center justify-center gap-1.5">
                <Button
                  size="icon"
                  variant={activeCall.muted ? 'destructive' : 'outline'}
                  className="h-9 w-9"
                  onClick={() => toggleMute(activeCall.id)}
                  title={activeCall.muted ? 'Activar micro' : 'Silenciar'}
                >
                  {activeCall.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button
                  size="icon"
                  variant={overlay === 'dialpad' ? 'secondary' : 'outline'}
                  className="h-9 w-9"
                  onClick={() => setOverlay(overlay === 'dialpad' ? 'none' : 'dialpad')}
                  title="Teclado DTMF"
                >
                  <Keyboard className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  className="h-10 w-10"
                  onClick={() => hangupCall(activeCall.id)}
                  title="Colgar"
                >
                  <PhoneOff className="h-5 w-5" />
                </Button>
              </div>

              {/* Secondary controls */}
              <div className="flex items-center justify-center gap-1.5">
                <Button
                  size="sm"
                  variant={overlay === 'transfer' ? 'secondary' : 'outline'}
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    setOverlay(overlay === 'transfer' ? 'none' : 'transfer');
                    setTransferSearch('');
                    setTransferNumber('');
                    loadAvailableUsers();
                  }}
                  title="Transferir llamada"
                >
                  <PhoneForwarded className="h-3 w-3" /> Transferir
                </Button>
                <Button
                  size="sm"
                  variant={overlay === 'consult' ? 'secondary' : 'outline'}
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    setOverlay(overlay === 'consult' ? 'none' : 'consult');
                    setTransferSearch('');
                    setDialNumber('');
                    loadAvailableUsers();
                  }}
                  title="Llamar a otra persona (consulta)"
                >
                  <UserPlus className="h-3 w-3" /> Consulta
                </Button>
                {hasMultipleCalls && !conferenceName && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={mergeCallsToConference}
                    title="Unir llamadas en conferencia"
                  >
                    <Users className="h-3 w-3" /> Unir
                  </Button>
                )}
                {conferenceName && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1 text-orange-600 border-orange-300 hover:bg-orange-50"
                    onClick={leaveConference}
                    title="Salir de la conferencia (los demás siguen)"
                  >
                    <LogOut className="h-3 w-3" /> Salir
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Connecting state — just show hangup */}
          {activeCall.state === 'connecting' && (
            <div className="flex items-center justify-center">
              <Button
                size="icon"
                variant="destructive"
                className="h-10 w-10"
                onClick={() => hangupCall(activeCall.id)}
                title="Cancelar"
              >
                <PhoneOff className="h-5 w-5" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Active state but no activeCall and calls exist ── */}
      {widgetState === 'active' && !activeCall && calls.length > 0 && (
        <div className="w-80 rounded-xl border bg-card p-3 shadow-2xl text-center">
          <p className="text-xs text-muted-foreground">
            {calls.length} llamada{calls.length > 1 ? 's' : ''} activa{calls.length > 1 ? 's' : ''}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 text-xs"
            onClick={() => {
              const first = calls[0];
              if (first) {
                unmuteCall(first.id);
                setActiveCallId(first.id);
              }
            }}
          >
            <Phone className="mr-1 h-3 w-3" /> Retomar
          </Button>
        </div>
      )}

      {/* ── New call dialpad (idle state) ── */}
      {widgetState === 'idle' && showNewCallDialpad && (
        <div className="w-80 rounded-xl border bg-card p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Nueva llamada</h3>
            <button onClick={() => setShowNewCallDialpad(false)} className="hover:opacity-70">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <Input
              placeholder="Número de destino (ej: 612345678)"
              value={dialNumber}
              onChange={(e) => setDialNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && makeOutboundCall(dialNumber)}
              className="text-center text-lg font-mono"
            />

            <div className="grid grid-cols-3 gap-1">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(d => (
                <button
                  key={d}
                  onClick={() => setDialNumber(prev => prev + d)}
                  className="rounded-md border bg-muted/50 py-3 text-lg font-medium hover:bg-muted transition-colors"
                >
                  {d}
                </button>
              ))}
            </div>

            {activeNumbers.length > 1 && (
              <Select value={fromNumber} onValueChange={(v) => setFromNumber(v ?? '')}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="Número de origen" />
                </SelectTrigger>
                <SelectContent>
                  {activeNumbers.map((n) => (
                    <SelectItem key={n.id} value={n.phone_number}>
                      {n.friendly_name || n.phone_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Button
              className="w-full bg-green-600 hover:bg-green-700 text-white"
              onClick={() => makeOutboundCall(dialNumber)}
              disabled={!dialNumber.trim() || !canDial}
            >
              <Phone className="mr-2 h-4 w-4" /> Llamar
            </Button>
          </div>
        </div>
      )}

      {/* ── FAB button (idle state) ── */}
      {widgetState === 'idle' && !showNewCallDialpad && (
        <div className="flex items-center gap-2">
          <div className={cn(
            'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border shadow-sm',
            softphoneBadgeClass
          )} title={softphoneReason || undefined}>
            {softphoneStatus === 'connected' ? <Wifi className="h-3 w-3" /> :
              softphoneStatus === 'reconnecting' ? <Loader2 className="h-3 w-3 animate-spin" /> :
              <WifiOff className="h-3 w-3" />}
            {softphoneBadgeLabel}
          </div>

          <Button
            size="icon"
            className={cn(
              'h-12 w-12 rounded-full shadow-lg',
              canDial ? 'bg-green-600 hover:bg-green-700' : 'bg-muted hover:bg-muted'
            )}
            onClick={() => {
              if (canDial) setShowNewCallDialpad(true);
              else { reconnectingRef.current = false; initDevice(); }
            }}
            title={canDial ? 'Nueva llamada' : `Reconectar${softphoneReason ? `: ${softphoneReason}` : ''}`}
          >
            <Phone className="h-5 w-5 text-white" />
          </Button>
        </div>
      )}
    </div>
  );
}



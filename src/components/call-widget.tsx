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
import type { PhoneNumber, User } from '@/lib/types/database';

// ─── Types ───────────────────────────────────────────────────────────────────

type WidgetState = 'idle' | 'connecting' | 'incoming' | 'active' | 'disconnected';

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

  const initDevice = useCallback(async () => {
    try {
      setError('');
      const res = await api.get<{ token: string; identity: string; userName: string }>('/token');
      if (!res.ok) {
        setError('Error obteniendo token de voz');
        return;
      }

      const { token, identity: id } = res.data;
      setIdentity(id);

      if (deviceRef.current) deviceRef.current.destroy();

      const device = new Device(token, {
        logLevel: 1,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });

      device.on('registered', () => { setRegistered(true); setError(''); });
      device.on('unregistered', () => { setRegistered(false); });
      device.on('error', (err: { message?: string }) => { setError(err.message || 'Error de dispositivo'); });

      device.on('incoming', (call: Call) => {
        console.log('[CallWidget] Incoming call from:', call.parameters.From);
        incomingCallRef.current = call;
        setIncomingInfo(call.parameters.From || 'Desconocido');
        setWidgetState('incoming');
      });

      device.on('tokenWillExpire', async () => {
        const refreshRes = await api.get<{ token: string }>('/token');
        if (refreshRes.ok) device.updateToken(refreshRes.data.token);
      });

      await device.register();
      deviceRef.current = device;
    } catch {
      setError('Error inicializando dispositivo de voz');
    }
  }, []);

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

      // After transfer, the agent's leg disconnects
      removeCallSlot(slot.id);
      setOverlay('none');
    } catch {
      setError('Error al transferir la llamada');
    }
  }, [getActiveCall, fromNumber, removeCallSlot]);

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
    return () => {
      deviceRef.current?.destroy();
      deviceRef.current = null;
      stopAllTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Compute derived state ─────────────────────────────────────────────────

  const activeCall = calls.find(c => c.id === activeCallId);
  const hasMultipleCalls = calls.length > 1;

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
              disabled={!dialNumber.trim() || !registered}
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
            registered
              ? 'bg-green-500/10 text-green-600 border-green-500/30'
              : 'bg-muted text-muted-foreground border-border'
          )}>
            {registered ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {registered ? 'Conectado' : 'Sin conexión'}
          </div>

          <Button
            size="icon"
            className={cn(
              'h-12 w-12 rounded-full shadow-lg',
              registered ? 'bg-green-600 hover:bg-green-700' : 'bg-muted hover:bg-muted'
            )}
            onClick={() => {
              if (registered) setShowNewCallDialpad(true);
              else initDevice();
            }}
            title={registered ? 'Nueva llamada' : 'Reconectar'}
          >
            <Phone className="h-5 w-5 text-white" />
          </Button>
        </div>
      )}
    </div>
  );
}

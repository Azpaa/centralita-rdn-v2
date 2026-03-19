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
  Volume2,
  VolumeX,
  Keyboard,
  X,
  Loader2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCall } from '@/contexts/call-context';
import type { PhoneNumber } from '@/lib/types/database';

type WidgetState =
  | 'idle'
  | 'connecting'
  | 'incoming'
  | 'active'
  | 'disconnected';

export function CallWidget() {
  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);

  const [state, setState] = useState<WidgetState>('idle');
  const [registered, setRegistered] = useState(false);
  const [muted, setMuted] = useState(false);
  const [callerInfo, setCallerInfo] = useState('');
  const [callDirection, setCallDirection] = useState<'inbound' | 'outbound'>('inbound');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Dialpad state
  const [showDialpad, setShowDialpad] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [activeNumbers, setActiveNumbers] = useState<PhoneNumber[]>([]);

  // Identity
  const [identity, setIdentity] = useState('');

  // Call context — allows other pages (e.g. Calls page) to trigger calls via Voice SDK
  const { registerDialHandler } = useCall();

  // Initialize Twilio Device
  const initDevice = useCallback(async () => {
    try {
      setError('');
      const res = await api.get<{ token: string; identity: string; userName: string }>('/token');
      if (!res.ok) {
        console.error('[CallWidget] Token error:', res.error);
        setError('Error obteniendo token de voz');
        return;
      }

      const { token, identity: id } = res.data;
      setIdentity(id);

      // Destroy previous device if any
      if (deviceRef.current) {
        deviceRef.current.destroy();
      }

      const device = new Device(token, {
        logLevel: 1,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });

      device.on('registered', () => {
        console.log('[CallWidget] Device registered');
        setRegistered(true);
        setError('');
      });

      device.on('unregistered', () => {
        console.log('[CallWidget] Device unregistered');
        setRegistered(false);
      });

      device.on('error', (err) => {
        console.error('[CallWidget] Device error:', err);
        setError(err.message || 'Error de dispositivo');
      });

      // Incoming call
      device.on('incoming', (call: Call) => {
        console.log('[CallWidget] Incoming call from:', call.parameters.From);
        activeCallRef.current = call;
        setCallerInfo(call.parameters.From || 'Desconocido');
        setCallDirection('inbound');
        setState('incoming');
        setupCallHandlers(call);
      });

      device.on('tokenWillExpire', async () => {
        console.log('[CallWidget] Token expiring, refreshing...');
        const refreshRes = await api.get<{ token: string }>('/token');
        if (refreshRes.ok) {
          device.updateToken(refreshRes.data.token);
        }
      });

      await device.register();
      deviceRef.current = device;
    } catch (err) {
      console.error('[CallWidget] Init error:', err);
      setError('Error inicializando dispositivo de voz');
    }
  }, []);

  // Setup handlers on a call
  const setupCallHandlers = useCallback((call: Call) => {
    call.on('accept', () => {
      console.log('[CallWidget] Call accepted');
      setState('active');
      startTimer();
    });

    call.on('disconnect', () => {
      console.log('[CallWidget] Call disconnected');
      cleanup();
    });

    call.on('cancel', () => {
      console.log('[CallWidget] Call canceled');
      cleanup();
    });

    call.on('reject', () => {
      console.log('[CallWidget] Call rejected');
      cleanup();
    });

    call.on('error', (err) => {
      console.error('[CallWidget] Call error:', err);
      setError(err.message || 'Error en la llamada');
      cleanup();
    });
  }, []);

  // Timer
  const startTimer = useCallback(() => {
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  }, []);

  const cleanup = useCallback(() => {
    setState('idle');
    setMuted(false);
    setCallerInfo('');
    setElapsed(0);
    activeCallRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Actions
  const answerCall = useCallback(() => {
    if (activeCallRef.current) {
      activeCallRef.current.accept();
    }
  }, []);

  const rejectCall = useCallback(() => {
    if (activeCallRef.current) {
      activeCallRef.current.reject();
      cleanup();
    }
  }, [cleanup]);

  const hangup = useCallback(() => {
    if (activeCallRef.current) {
      activeCallRef.current.disconnect();
    }
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    if (activeCallRef.current) {
      const newMuted = !muted;
      activeCallRef.current.mute(newMuted);
      setMuted(newMuted);
    }
  }, [muted]);

  const sendDtmf = useCallback((digit: string) => {
    if (activeCallRef.current) {
      activeCallRef.current.sendDigits(digit);
    }
  }, []);

  // Make outbound call from browser
  const makeCall = useCallback(async () => {
    if (!deviceRef.current || !dialNumber.trim()) return;

    let formattedNumber = dialNumber.trim();
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = `+34${formattedNumber}`;
    }

    setState('connecting');
    setCallerInfo(formattedNumber);
    setCallDirection('outbound');

    try {
      const call = await deviceRef.current.connect({
        params: {
          To: formattedNumber,
          CallerId: fromNumber,
          UserId: identity,
        },
      });

      activeCallRef.current = call;
      setupCallHandlers(call);
      setShowDialpad(false);
      setDialNumber('');
    } catch (err) {
      console.error('[CallWidget] Dial error:', err);
      setError('Error al iniciar llamada');
      setState('idle');
    }
  }, [dialNumber, fromNumber, identity, setupCallHandlers]);

  // External dial — triggered by other components via CallContext
  // This bypasses the internal dialpad state and dials directly via Voice SDK
  const externalDial = useCallback(async (number: string, from?: string) => {
    if (!deviceRef.current) {
      setError('Dispositivo de voz no conectado. Espera a que aparezca "Conectado".');
      return;
    }

    let formattedNumber = number.trim();
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = `+34${formattedNumber}`;
    }

    const callerIdToUse = from || fromNumber;

    setState('connecting');
    setCallerInfo(formattedNumber);
    setCallDirection('outbound');
    setShowDialpad(false);

    try {
      const call = await deviceRef.current.connect({
        params: {
          To: formattedNumber,
          CallerId: callerIdToUse,
          UserId: identity,
        },
      });

      activeCallRef.current = call;
      setupCallHandlers(call);
    } catch (err) {
      console.error('[CallWidget] External dial error:', err);
      setError('Error al iniciar llamada');
      setState('idle');
    }
  }, [fromNumber, identity, setupCallHandlers]);

  // Register the external dial handler with the CallContext
  useEffect(() => {
    registerDialHandler(externalDial);
  }, [registerDialHandler, externalDial]);

  // Load active numbers for outbound
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
  }, []);

  // Initialize device on mount
  useEffect(() => {
    initDevice();
    return () => {
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [initDevice]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // --- RENDER ---

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {/* Error toast */}
      {error && (
        <div className="mb-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="hover:opacity-70">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Incoming call alert */}
      {state === 'incoming' && (
        <div className="mb-2 w-80 animate-pulse rounded-xl border border-green-500/50 bg-card p-4 shadow-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/20">
              <PhoneIncoming className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-sm font-semibold">Llamada entrante</p>
              <p className="text-xs text-muted-foreground">{callerInfo}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 bg-green-600 hover:bg-green-700 text-white"
              onClick={answerCall}
            >
              <Phone className="mr-1 h-4 w-4" /> Contestar
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="flex-1"
              onClick={rejectCall}
            >
              <PhoneOff className="mr-1 h-4 w-4" /> Rechazar
            </Button>
          </div>
        </div>
      )}

      {/* Active call bar */}
      {(state === 'active' || state === 'connecting') && (
        <div className="mb-2 w-80 rounded-xl border bg-card p-4 shadow-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full',
                state === 'connecting'
                  ? 'bg-yellow-500/20'
                  : 'bg-green-500/20'
              )}
            >
              {state === 'connecting' ? (
                <Loader2 className="h-5 w-5 text-yellow-500 animate-spin" />
              ) : callDirection === 'outbound' ? (
                <PhoneOutgoing className="h-5 w-5 text-green-500" />
              ) : (
                <PhoneIncoming className="h-5 w-5 text-green-500" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {state === 'connecting' ? 'Conectando...' : 'En llamada'}
              </p>
              <p className="text-xs text-muted-foreground">{callerInfo}</p>
            </div>
            {state === 'active' && (
              <span className="text-xs font-mono text-muted-foreground">
                {formatTime(elapsed)}
              </span>
            )}
          </div>

          {/* In-call DTMF pad (mini) */}
          {state === 'active' && showDialpad && (
            <div className="mb-3 grid grid-cols-3 gap-1">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(
                (digit) => (
                  <button
                    key={digit}
                    onClick={() => sendDtmf(digit)}
                    className="rounded-md border bg-muted/50 py-2 text-sm font-medium hover:bg-muted transition-colors"
                  >
                    {digit}
                  </button>
                )
              )}
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-2">
            <Button
              size="icon"
              variant={muted ? 'destructive' : 'outline'}
              className="h-9 w-9"
              onClick={toggleMute}
              title={muted ? 'Activar micro' : 'Silenciar'}
            >
              {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button
              size="icon"
              variant={showDialpad ? 'secondary' : 'outline'}
              className="h-9 w-9"
              onClick={() => setShowDialpad(!showDialpad)}
              title="Teclado DTMF"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="destructive"
              className="h-10 w-10"
              onClick={hangup}
              title="Colgar"
            >
              <PhoneOff className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}

      {/* Dialpad for new calls */}
      {state === 'idle' && showDialpad && (
        <div className="mb-2 w-80 rounded-xl border bg-card p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Nueva llamada</h3>
            <button onClick={() => setShowDialpad(false)} className="hover:opacity-70">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <Input
              placeholder="Número de destino (ej: 612345678)"
              value={dialNumber}
              onChange={(e) => setDialNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && makeCall()}
              className="text-center text-lg font-mono"
            />

            {/* Dialpad buttons */}
            <div className="grid grid-cols-3 gap-1">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(
                (digit) => (
                  <button
                    key={digit}
                    onClick={() => setDialNumber((prev) => prev + digit)}
                    className="rounded-md border bg-muted/50 py-3 text-lg font-medium hover:bg-muted transition-colors"
                  >
                    {digit}
                  </button>
                )
              )}
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
              onClick={makeCall}
              disabled={!dialNumber.trim() || !registered}
            >
              <Phone className="mr-2 h-4 w-4" /> Llamar
            </Button>
          </div>
        </div>
      )}

      {/* FAB button */}
      {state === 'idle' && !showDialpad && (
        <div className="flex items-center gap-2">
          {/* Status indicator */}
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border shadow-sm',
              registered
                ? 'bg-green-500/10 text-green-600 border-green-500/30'
                : 'bg-muted text-muted-foreground border-border'
            )}
          >
            {registered ? (
              <Wifi className="h-3 w-3" />
            ) : (
              <WifiOff className="h-3 w-3" />
            )}
            {registered ? 'Conectado' : 'Sin conexión'}
          </div>

          {/* Call button */}
          <Button
            size="icon"
            className={cn(
              'h-12 w-12 rounded-full shadow-lg',
              registered
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-muted hover:bg-muted'
            )}
            onClick={() => {
              if (registered) {
                setShowDialpad(true);
              } else {
                initDevice();
              }
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

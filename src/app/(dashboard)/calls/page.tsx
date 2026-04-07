'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api/client';
import type { CallRecord, PhoneNumber } from '@/lib/types/database';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Search, ChevronLeft, ChevronRight, PhoneOutgoing, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useCall } from '@/contexts/call-context';

const STATUS_COLORS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  completed: 'default',
  in_progress: 'secondary',
  ringing: 'secondary',
  in_queue: 'secondary',
  no_answer: 'outline',
  busy: 'outline',
  failed: 'destructive',
  canceled: 'outline',
};

// Labels base (para estados que no dependen de la dirección)
const STATUS_LABELS_BASE: Record<string, string> = {
  ringing: 'Sonando',
  in_queue: 'En cola',
  in_progress: 'En curso',
  completed: 'Completada',
  busy: 'Ocupado',
  failed: 'Fallida',
  canceled: 'Cancelada',
};

/**
 * Label contextual según dirección:
 * - no_answer + outbound → "Rechazada" (no nos respondieron)
 * - no_answer + inbound  → "No atendida" (no cogimos nosotros)
 */
function getStatusLabel(status: string, direction?: string): string {
  if (status === 'no_answer') {
    return direction === 'outbound' ? 'Rechazada' : 'No atendida';
  }
  return STATUS_LABELS_BASE[status] || status;
}

interface CallDetail extends CallRecord {
  recordings?: Array<{ id: string; url: string; duration: number | null; status: string }>;
  answered_by_user?: { id: string; name: string; email: string } | null;
}

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const limit = 20;

  // Filters
  const [filterDirection, setFilterDirection] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterFrom, setFilterFrom] = useState('');

  // Dial dialog
  const [dialOpen, setDialOpen] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [dialFromNumber, setDialFromNumber] = useState('');
  const [activeNumbers, setActiveNumbers] = useState<PhoneNumber[]>([]);

  // Call context — sends dial command to backend; audio is then attached in Voice SDK
  const { dial } = useCall();

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (filterDirection) params.set('direction', filterDirection);
    if (filterStatus) params.set('status', filterStatus);
    if (filterFrom) params.set('from_number', filterFrom);

    const res = await api.get<CallRecord[]>(`/calls?${params}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (res.ok) {
      setCalls(res.data);
      setTotal(res.meta?.total ?? 0);
    } else {
      setError(res.error || 'Error al cargar llamadas');
    }
    setLoading(false);
  }, [page, filterDirection, filterStatus, filterFrom]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Cargar números Twilio activos para el diálogo de llamada
  useEffect(() => {
    api.get<PhoneNumber[]>('/phone-numbers?limit=100').then((res) => {
      if (res.ok) {
        const active = res.data.filter(n => n.active);
        setActiveNumbers(active);
        // Auto-seleccionar si solo hay un número activo
        if (active.length === 1) setDialFromNumber(active[0].phone_number);
      }
    });
  }, []);

  async function openDetail(call: CallRecord) {
    const res = await api.get<CallDetail>(`/calls/${call.id}`);
    if (res.ok) {
      setDetail(res.data);
      setDetailOpen(true);
    }
  }

  const totalPages = Math.ceil(total / limit);

  async function handleDial() {
    if (!dialNumber || !dialFromNumber) return;

    // Auto-formatear número: añadir +34 si no tiene prefijo internacional
    let formattedNumber = dialNumber.trim();
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = `+34${formattedNumber}`;
    }

    // Route through backend dial command via CallWidget (backend source of truth)
    dial(formattedNumber, dialFromNumber);
    toast.success('Llamada iniciada al ' + formattedNumber);
    setDialOpen(false);
    setDialNumber('');
    // Refrescar la lista después de un breve delay para que el registro aparezca
    setTimeout(() => load(), 3000);
  }

  function formatDuration(seconds: number | null): string {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Historial de llamadas</h1>
          <p className="text-muted-foreground">Registro de todas las llamadas</p>
        </div>
        <Button onClick={() => setDialOpen(true)}>
          <PhoneOutgoing className="mr-2 h-4 w-4" /> Nueva llamada
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="w-40">
          <Select value={filterDirection || 'all'} onValueChange={(v) => { setFilterDirection(v === 'all' ? '' : (v ?? '')); setPage(1); }}>
            <SelectTrigger><SelectValue placeholder="Dirección" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="inbound">Entrantes</SelectItem>
              <SelectItem value="outbound">Salientes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Select value={filterStatus || 'all'} onValueChange={(v) => { setFilterStatus(v === 'all' ? '' : (v ?? '')); setPage(1); }}>
            <SelectTrigger><SelectValue placeholder="Estado" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="completed">Completada</SelectItem>
              <SelectItem value="no_answer">Rechazada / No atendida</SelectItem>
              <SelectItem value="failed">Fallida</SelectItem>
              <SelectItem value="in_progress">En curso</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="relative w-48">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Número origen..."
            className="pl-9"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dirección</TableHead>
              <TableHead>Desde</TableHead>
              <TableHead>Hacia</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Duración</TableHead>
              <TableHead>Fecha</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando...</TableCell>
              </TableRow>
            ) : calls.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No hay llamadas</TableCell>
              </TableRow>
            ) : (
              calls.map((call) => (
                <TableRow
                  key={call.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => openDetail(call)}
                >
                  <TableCell>
                    <Badge variant="outline">
                      {call.direction === 'inbound' ? '↙ Entrante' : '↗ Saliente'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{call.from_number}</TableCell>
                  <TableCell className="font-mono text-sm">{call.to_number}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_COLORS[call.status] || 'outline'}>
                      {getStatusLabel(call.status, call.direction)}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDuration(call.duration)}</TableCell>
                  <TableCell>
                    {new Date(call.started_at).toLocaleString('es-ES', {
                      day: '2-digit', month: '2-digit', year: '2-digit',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total} llamada{total !== 1 ? 's' : ''} — Página {page} de {totalPages}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Detalle de llamada</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-y-3">
                <div>
                  <Label className="text-muted-foreground">Dirección</Label>
                  <p>{detail.direction === 'inbound' ? 'Entrante' : 'Saliente'}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Estado</Label>
                  <p><Badge variant={STATUS_COLORS[detail.status]}>{getStatusLabel(detail.status, detail.direction)}</Badge></p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Desde</Label>
                  <p className="font-mono">{detail.from_number}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Hacia</Label>
                  <p className="font-mono">{detail.to_number}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Duración</Label>
                  <p>{formatDuration(detail.duration)}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Espera</Label>
                  <p>{detail.wait_time ? `${detail.wait_time}s` : '—'}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Inicio</Label>
                  <p>{new Date(detail.started_at).toLocaleString('es-ES')}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Respondida por</Label>
                  <p>{detail.answered_by_user?.name || '—'}</p>
                </div>
              </div>

              {detail.recordings && detail.recordings.length > 0 && (
                <div>
                  <Label className="text-muted-foreground">Grabaciones</Label>
                  <div className="mt-1 space-y-2">
                    {detail.recordings.map((rec) => (
                      <div key={rec.id} className="flex items-center gap-2 rounded border p-2">
                        <Badge variant="secondary">{rec.status}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {rec.duration ? `${rec.duration}s` : '—'}
                        </span>
                        <a
                          href={rec.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary underline ml-auto"
                        >
                          Escuchar
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dial Dialog */}
      <Dialog open={dialOpen} onOpenChange={setDialOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Nueva llamada saliente</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Número destino</Label>
              <Input
                placeholder="648728412"
                value={dialNumber}
                onChange={(e) => setDialNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Se añade +34 automáticamente si no incluyes prefijo</p>
            </div>
            <div className="space-y-2">
              <Label>Llamar desde</Label>
              {activeNumbers.length === 0 ? (
                <p className="text-sm text-destructive py-2">
                  No hay números activos. Ve a Números de teléfono y activa al menos uno.
                </p>
              ) : activeNumbers.length === 1 ? (
                <div className="flex items-center gap-2 rounded-md border px-3 py-2 bg-muted/50">
                  <span className="font-mono text-sm">{activeNumbers[0].phone_number}</span>
                  <span className="text-xs text-muted-foreground">{activeNumbers[0].friendly_name || ''}</span>
                </div>
              ) : (
                <Select value={dialFromNumber || '_placeholder'} onValueChange={(v) => setDialFromNumber(v === '_placeholder' ? '' : (v ?? ''))}>
                  <SelectTrigger><SelectValue placeholder="Selecciona número" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_placeholder" disabled>Selecciona número...</SelectItem>
                    {activeNumbers.map((pn) => (
                      <SelectItem key={pn.id} value={pn.phone_number}>
                        {pn.phone_number} {pn.friendly_name ? `— ${pn.friendly_name}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialOpen(false)}>Cancelar</Button>
            <Button onClick={handleDial} disabled={!dialNumber || !dialFromNumber}>
              Llamar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

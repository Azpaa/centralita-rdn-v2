'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api/client';
import type { PhoneNumber, Queue, Schedule } from '@/lib/types/database';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Pencil, RefreshCw, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

export default function PhoneNumbersPage() {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PhoneNumber | null>(null);

  const [formFriendlyName, setFormFriendlyName] = useState('');
  const [formQueueId, setFormQueueId] = useState('');
  const [formScheduleId, setFormScheduleId] = useState('');
  const [formWelcomeMsg, setFormWelcomeMsg] = useState('');
  const [formOohAction, setFormOohAction] = useState('hangup');
  const [formOohMsg, setFormOohMsg] = useState('');
  const [formRecordCalls, setFormRecordCalls] = useState(true);
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [numRes, qRes, sRes] = await Promise.all([
      api.get<PhoneNumber[]>('/phone-numbers?limit=100'),
      api.get<Queue[]>('/queues?limit=100'),
      api.get<Schedule[]>('/schedules?limit=100'),
    ]);
    if (numRes.ok) setNumbers(numRes.data);
    if (qRes.ok) setQueues(qRes.data);
    if (sRes.ok) setSchedules(sRes.data);
    const errors = [numRes, qRes, sRes].filter((r) => !r.ok);
    if (errors.length) setError('Error al cargar datos');
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleSync() {
    setSyncing(true);
    const res = await api.post('/phone-numbers/sync', {});
    if (res.ok) { toast.success('Números sincronizados'); load(); }
    else toast.error(res.error || 'Error al sincronizar');
    setSyncing(false);
  }

  function openEdit(pn: PhoneNumber) {
    setEditing(pn);
    setFormFriendlyName(pn.friendly_name || '');
    setFormQueueId(pn.queue_id || '');
    setFormScheduleId(pn.schedule_id || '');
    setFormWelcomeMsg(pn.welcome_message || '');
    setFormOohAction(pn.ooh_action);
    setFormOohMsg(pn.ooh_message || '');
    setFormRecordCalls(pn.record_calls);
    setFormActive(pn.active);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    const body = {
      friendly_name: formFriendlyName || null,
      queue_id: formQueueId || null,
      schedule_id: formScheduleId || null,
      welcome_message: formWelcomeMsg || null,
      ooh_action: formOohAction,
      ooh_message: formOohMsg || null,
      record_calls: formRecordCalls,
      active: formActive,
    };
    const res = await api.put(`/phone-numbers/${editing.id}`, body);
    if (res.ok) { toast.success('Número actualizado'); setDialogOpen(false); load(); }
    else toast.error(res.error || 'Error al actualizar');
    setSaving(false);
  }

  const queueMap = new Map(queues.map((q) => [q.id, q.name]));
  const scheduleMap = new Map(schedules.map((s) => [s.id, s.name]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Números de teléfono</h1>
          <p className="text-muted-foreground">Números de Twilio asignados a la centralita</p>
        </div>
        <Button onClick={handleSync} disabled={syncing} variant="outline">
          <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando...' : 'Sincronizar Twilio'}
        </Button>
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
              <TableHead>Número</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Cola</TableHead>
              <TableHead>Horario</TableHead>
              <TableHead>Grabar</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="w-16">Editar</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Cargando...</TableCell>
              </TableRow>
            ) : numbers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No hay números. Usa Sincronizar Twilio para importarlos.
                </TableCell>
              </TableRow>
            ) : (
              numbers.map((pn) => (
                <TableRow key={pn.id}>
                  <TableCell className="font-mono font-medium">{pn.phone_number}</TableCell>
                  <TableCell>{pn.friendly_name || '—'}</TableCell>
                  <TableCell>{pn.queue_id ? queueMap.get(pn.queue_id) || '—' : '—'}</TableCell>
                  <TableCell>{pn.schedule_id ? scheduleMap.get(pn.schedule_id) || '—' : '—'}</TableCell>
                  <TableCell>{pn.record_calls ? '✓' : '—'}</TableCell>
                  <TableCell>
                    <Badge variant={pn.active ? 'default' : 'outline'}>
                      {pn.active ? 'Activo' : 'Inactivo'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(pn)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Configurar número {editing?.phone_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Nombre amigable</Label>
              <Input value={formFriendlyName} onChange={(e) => setFormFriendlyName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Cola asignada</Label>
              <Select value={formQueueId} onValueChange={(v) => setFormQueueId(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Sin cola" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Sin cola</SelectItem>
                  {queues.map((q) => (
                    <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Horario</Label>
              <Select value={formScheduleId} onValueChange={(v) => setFormScheduleId(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Sin horario" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Sin horario</SelectItem>
                  {schedules.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mensaje de bienvenida</Label>
              <Input value={formWelcomeMsg} onChange={(e) => setFormWelcomeMsg(e.target.value)} placeholder="Gracias por llamar a..." />
            </div>
            <div className="space-y-2">
              <Label>Acción fuera de horario</Label>
              <Select value={formOohAction} onValueChange={(v) => setFormOohAction(v ?? 'hangup')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hangup">Colgar</SelectItem>
                  <SelectItem value="forward">Reenviar</SelectItem>
                  <SelectItem value="voicemail">Buzón de voz</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mensaje fuera de horario</Label>
              <Input value={formOohMsg} onChange={(e) => setFormOohMsg(e.target.value)} placeholder="Estamos fuera de horario..." />
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={formRecordCalls} onCheckedChange={setFormRecordCalls} />
              <Label>Grabar llamadas</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={formActive} onCheckedChange={setFormActive} />
              <Label>Número activo</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando...' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

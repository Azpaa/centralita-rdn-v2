'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api/client';
import type { Schedule } from '@/lib/types/database';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Pencil, Trash2, PlusCircle, X } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';

interface Slot {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface ScheduleWithSlots extends Schedule {
  slots?: Slot[];
}

const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleWithSlots | null>(null);

  const [formName, setFormName] = useState('');
  const [formTimezone, setFormTimezone] = useState('Europe/Madrid');
  const [formSlots, setFormSlots] = useState<Slot[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.get<Schedule[]>('/schedules?limit=100');
    if (res.ok) setSchedules(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setFormName('');
    setFormTimezone('Europe/Madrid');
    setFormSlots([
      { day_of_week: 1, start_time: '09:00', end_time: '18:00' },
      { day_of_week: 2, start_time: '09:00', end_time: '18:00' },
      { day_of_week: 3, start_time: '09:00', end_time: '18:00' },
      { day_of_week: 4, start_time: '09:00', end_time: '18:00' },
      { day_of_week: 5, start_time: '09:00', end_time: '18:00' },
    ]);
    setDialogOpen(true);
  }

  async function openEdit(s: Schedule) {
    const res = await api.get<ScheduleWithSlots>(`/schedules/${s.id}`);
    if (res.ok) {
      setEditing(res.data);
      setFormName(res.data.name);
      setFormTimezone(res.data.timezone);
      setFormSlots(res.data.slots || []);
    }
    setDialogOpen(true);
  }

  function addSlot() {
    setFormSlots([...formSlots, { day_of_week: 1, start_time: '09:00', end_time: '18:00' }]);
  }

  function removeSlot(idx: number) {
    setFormSlots(formSlots.filter((_, i) => i !== idx));
  }

  function updateSlot(idx: number, field: keyof Slot, value: string | number) {
    setFormSlots(formSlots.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  }

  async function handleSave() {
    setSaving(true);
    const body = {
      name: formName,
      timezone: formTimezone,
      slots: formSlots,
    };

    if (editing) {
      const res = await api.put(`/schedules/${editing.id}`, body);
      if (res.ok) { toast.success('Horario actualizado'); setDialogOpen(false); load(); }
      else toast.error(res.error || 'Error al actualizar');
    } else {
      const res = await api.post('/schedules', body);
      if (res.ok) { toast.success('Horario creado'); setDialogOpen(false); load(); }
      else toast.error(res.error || 'Error al crear');
    }
    setSaving(false);
  }

  async function handleDelete(s: Schedule) {
    if (!confirm(`¿Eliminar horario "${s.name}"?`)) return;
    const res = await api.delete(`/schedules/${s.id}`);
    if (res.ok) { toast.success('Horario eliminado'); load(); }
    else toast.error(res.error || 'Error al eliminar');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Horarios</h1>
          <p className="text-muted-foreground">Franjas horarias de atención</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Nuevo horario
        </Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Zona horaria</TableHead>
              <TableHead>Creado</TableHead>
              <TableHead className="w-24">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Cargando...</TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No hay horarios</TableCell>
              </TableRow>
            ) : (
              schedules.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.timezone}</TableCell>
                  <TableCell>{new Date(s.created_at).toLocaleDateString('es-ES')}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(s)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(s)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar horario' : 'Nuevo horario'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nombre</Label>
                <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Zona horaria</Label>
                <Input value={formTimezone} onChange={(e) => setFormTimezone(e.target.value)} />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-base">Franjas horarias</Label>
                <Button variant="outline" size="sm" onClick={addSlot}>
                  <PlusCircle className="mr-1 h-3 w-3" /> Añadir
                </Button>
              </div>
              {formSlots.map((slot, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded-md border p-2">
                  <Select
                    value={String(slot.day_of_week)}
                    onValueChange={(v) => updateSlot(idx, 'day_of_week', Number(v))}
                  >
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAYS.map((d, i) => (
                        <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="time"
                    className="w-28"
                    value={slot.start_time}
                    onChange={(e) => updateSlot(idx, 'start_time', e.target.value)}
                  />
                  <span className="text-muted-foreground">a</span>
                  <Input
                    type="time"
                    className="w-28"
                    value={slot.end_time}
                    onChange={(e) => updateSlot(idx, 'end_time', e.target.value)}
                  />
                  <Button variant="ghost" size="icon" onClick={() => removeSlot(idx)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving || !formName}>
              {saving ? 'Guardando...' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api/client';
import type { Queue, User, QueueUser } from '@/lib/types/database';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, Trash2, Users, UserPlus, X, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

// Tipos para la respuesta del detalle de cola
type QueueUserWithDetail = QueueUser & {
  user: { id: string; name: string; email: string; phone: string | null; available: boolean; active: boolean } | null;
};

type QueueDetail = Queue & {
  users: QueueUserWithDetail[];
};

export default function QueuesPage() {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});

  // Dialog crear/editar cola
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Queue | null>(null);
  const [formName, setFormName] = useState('');
  const [formStrategy, setFormStrategy] = useState<'ring_all' | 'round_robin'>('ring_all');
  const [formRingTimeout, setFormRingTimeout] = useState(25);
  const [formMaxWait, setFormMaxWait] = useState(180);
  const [formTimeoutAction, setFormTimeoutAction] = useState<string>('hangup');
  const [saving, setSaving] = useState(false);

  // Dialog gestion de miembros
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersQueue, setMembersQueue] = useState<QueueDetail | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [addingUserId, setAddingUserId] = useState('');
  const [addingPriority, setAddingPriority] = useState(0);
  const [addingMember, setAddingMember] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<Queue[]>('/queues?limit=100');
    if (res.ok) {
      setQueues(res.data);
      // Cargar conteo de miembros para cada cola
      const counts: Record<string, number> = {};
      await Promise.all(
        res.data.map(async (q) => {
          const detail = await api.get<QueueDetail>(`/queues/${q.id}`);
          if (detail.ok) {
            counts[q.id] = detail.data.users?.length || 0;
          }
        })
      );
      setMemberCounts(counts);
    } else {
      setError(res.error || 'Error al cargar colas');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Cargar todos los usuarios activos
  useEffect(() => {
    api.get<User[]>('/users?active=true&limit=100').then((res) => {
      if (res.ok) setAllUsers(res.data);
    });
  }, []);

  // --- CRUD de colas ---

  function openCreate() {
    setEditing(null);
    setFormName('');
    setFormStrategy('ring_all');
    setFormRingTimeout(25);
    setFormMaxWait(180);
    setFormTimeoutAction('hangup');
    setDialogOpen(true);
  }

  function openEdit(q: Queue) {
    setEditing(q);
    setFormName(q.name);
    setFormStrategy(q.strategy);
    setFormRingTimeout(q.ring_timeout);
    setFormMaxWait(q.max_wait_time);
    setFormTimeoutAction(q.timeout_action);
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    const body = {
      name: formName,
      strategy: formStrategy,
      ring_timeout: formRingTimeout,
      max_wait_time: formMaxWait,
      timeout_action: formTimeoutAction,
    };

    if (editing) {
      const res = await api.put(`/queues/${editing.id}`, body);
      if (res.ok) { toast.success('Cola actualizada'); setDialogOpen(false); load(); }
      else toast.error(res.error || 'Error al actualizar');
    } else {
      const res = await api.post('/queues', body);
      if (res.ok) { toast.success('Cola creada'); setDialogOpen(false); load(); }
      else toast.error(res.error || 'Error al crear');
    }
    setSaving(false);
  }

  async function handleDelete(q: Queue) {
    if (!confirm(`¿Eliminar cola "${q.name}"?`)) return;
    const res = await api.delete(`/queues/${q.id}`);
    if (res.ok) { toast.success('Cola eliminada'); load(); }
    else toast.error(res.error || 'Error al eliminar');
  }

  // --- Gestion de miembros ---

  async function openMembers(q: Queue) {
    setMembersLoading(true);
    setMembersOpen(true);
    setAddingUserId('');
    setAddingPriority(0);

    const res = await api.get<QueueDetail>(`/queues/${q.id}`);
    if (res.ok) {
      setMembersQueue(res.data);
    } else {
      toast.error('Error al cargar la cola');
      setMembersOpen(false);
    }
    setMembersLoading(false);
  }

  async function refreshMembers() {
    if (!membersQueue) return;
    const res = await api.get<QueueDetail>(`/queues/${membersQueue.id}`);
    if (res.ok) {
      setMembersQueue(res.data);
      // Actualizar conteo de miembros
      setMemberCounts((prev) => ({
        ...prev,
        [membersQueue.id]: res.data.users?.length || 0,
      }));
    }
  }

  async function handleAddMember() {
    if (!addingUserId || !membersQueue) return;
    setAddingMember(true);

    const res = await api.post(`/queues/${membersQueue.id}/users`, {
      user_id: addingUserId,
      priority: addingPriority,
    });

    if (res.ok) {
      toast.success('Operador añadido a la cola');
      setAddingUserId('');
      setAddingPriority(0);
      await refreshMembers();
    } else {
      toast.error(res.error || 'Error al añadir operador');
    }
    setAddingMember(false);
  }

  async function handleRemoveMember(userId: string, userName: string) {
    if (!membersQueue) return;
    if (!confirm(`¿Quitar a "${userName}" de esta cola?`)) return;

    const res = await api.delete(`/queues/${membersQueue.id}/users/${userId}`);
    if (res.ok) {
      toast.success('Operador eliminado de la cola');
      await refreshMembers();
    } else {
      toast.error(res.error || 'Error al eliminar operador');
    }
  }

  // Usuarios disponibles para añadir (que no esten ya en la cola)
  const currentMemberIds = new Set((membersQueue?.users || []).map(qu => qu.user_id));
  const availableUsers = allUsers.filter(u => !currentMemberIds.has(u.id));

  const strategyLabel: Record<string, string> = {
    ring_all: 'Sonar todos',
    round_robin: 'Rotativo',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Colas</h1>
          <p className="text-muted-foreground">Colas de atención de llamadas</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Nueva cola
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
              <TableHead>Nombre</TableHead>
              <TableHead>Estrategia</TableHead>
              <TableHead>Miembros</TableHead>
              <TableHead>Timeout ring</TableHead>
              <TableHead>Espera máx.</TableHead>
              <TableHead>Acción timeout</TableHead>
              <TableHead className="w-32">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Cargando...</TableCell>
              </TableRow>
            ) : queues.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No hay colas</TableCell>
              </TableRow>
            ) : (
              queues.map((q) => (
                <TableRow key={q.id}>
                  <TableCell className="font-medium">{q.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{strategyLabel[q.strategy] || q.strategy}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => openMembers(q)}
                    >
                      <Users className="h-3.5 w-3.5" />
                      {memberCounts[q.id] ?? 0} operadores
                    </Button>
                  </TableCell>
                  <TableCell>{q.ring_timeout}s</TableCell>
                  <TableCell>{q.max_wait_time}s</TableCell>
                  <TableCell>{q.timeout_action}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(q)} title="Editar cola">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(q)} title="Eliminar cola">
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

      {/* Dialog crear/editar cola */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar cola' : 'Nueva cola'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Estrategia</Label>
              <Select value={formStrategy} onValueChange={(v) => setFormStrategy((v ?? 'ring_all') as 'ring_all' | 'round_robin')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ring_all">Sonar todos</SelectItem>
                  <SelectItem value="round_robin">Rotativo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Timeout ring (s)</Label>
                <Input type="number" value={formRingTimeout} onChange={(e) => setFormRingTimeout(Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Espera máx. (s)</Label>
                <Input type="number" value={formMaxWait} onChange={(e) => setFormMaxWait(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Acción si timeout</Label>
              <Select value={formTimeoutAction} onValueChange={(v) => setFormTimeoutAction(v ?? 'hangup')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hangup">Colgar</SelectItem>
                  <SelectItem value="forward">Reenviar</SelectItem>
                  <SelectItem value="voicemail">Buzón de voz</SelectItem>
                  <SelectItem value="keep_waiting">Seguir esperando</SelectItem>
                </SelectContent>
              </Select>
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

      {/* Dialog gestion de miembros */}
      <Dialog open={membersOpen} onOpenChange={setMembersOpen}>
        <DialogContent className="!w-[96vw] !max-w-[96vw] sm:!max-w-4xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Miembros de &quot;{membersQueue?.name}&quot;
            </DialogTitle>
          </DialogHeader>

          {membersLoading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando...</div>
          ) : (
            <div className="space-y-4">
              {/* Lista de miembros actuales */}
              <div>
                <Label className="text-sm font-medium">Operadores en la cola</Label>
                {(!membersQueue?.users || membersQueue.users.length === 0) ? (
                  <p className="mt-2 text-sm text-muted-foreground py-4 text-center border rounded-md">
                    No hay operadores asignados a esta cola
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {membersQueue.users.map((qu) => (
                      <div
                        key={qu.id}
                        className="grid gap-2 rounded-md border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {qu.user?.name || 'Usuario eliminado'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {qu.user?.phone || 'Sin teléfono'}
                              {qu.user?.email ? ` · ${qu.user.email}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
                          <Badge variant="outline" className="text-xs">
                            Prioridad {qu.priority}
                          </Badge>
                          {qu.user?.available ? (
                            <Badge variant="default" className="text-xs">Disponible</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">No disponible</Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleRemoveMember(qu.user_id, qu.user?.name || '')}
                            title="Quitar de la cola"
                          >
                            <X className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Formulario para añadir miembro */}
              <div className="border-t pt-4">
                <Label className="text-sm font-medium">Añadir operador</Label>
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_auto]">
                  <div className="flex-1">
                    <Select value={addingUserId || '_placeholder'} onValueChange={(v) => setAddingUserId(v === '_placeholder' ? '' : (v ?? ''))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona usuario..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_placeholder" disabled>Selecciona usuario...</SelectItem>
                        {availableUsers.length === 0 ? (
                          <SelectItem value="_none" disabled>
                            No hay más usuarios disponibles
                          </SelectItem>
                        ) : (
                          availableUsers.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.name} {u.phone ? `(${u.phone})` : '— sin tel.'}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:w-[6.5rem]">
                    <Input
                      type="number"
                      min={0}
                      placeholder="Prioridad"
                      value={addingPriority}
                      onChange={(e) => setAddingPriority(Number(e.target.value))}
                      title="Prioridad (menor = mayor prioridad)"
                    />
                  </div>
                  <Button
                    size="icon"
                    className="justify-self-start"
                    onClick={handleAddMember}
                    disabled={addingMember || !addingUserId}
                    title="Añadir"
                  >
                    <UserPlus className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Menor número de prioridad = se le llama antes (en modo rotativo)
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setMembersOpen(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

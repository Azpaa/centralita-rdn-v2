import { createAdminClient } from '@/lib/supabase/admin';

export type AuditAction =
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.activated'
  | 'user.deactivated'
  | 'user.availability_changed'
  | 'user.linked_rdn'
  | 'queue.created'
  | 'queue.updated'
  | 'queue.deleted'
  | 'queue.user_added'
  | 'queue.user_removed'
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.deleted'
  | 'phone_number.updated'
  | 'phone_number.synced'
  | 'call.started'
  | 'call.completed'
  | 'call.dial'
  | 'call.hangup'
  | 'call.hold'
  | 'call.resume'
  | 'call.transfer'
  | 'call.accept_requested'
  | 'call.accept_confirmed'
  | 'call.mute'
  | 'call.unmute'
  | 'call.conference'
  | 'api_key.created'
  | 'api_key.deleted';

/**
 * Registra una acción en el log de auditoría.
 * Fire-and-forget: no bloquea ni lanza errores.
 */
export async function auditLog(
  action: AuditAction,
  entity: string,
  entityId: string | null,
  userId: string | null,
  details?: Record<string, unknown>
) {
  try {
    const supabase = createAdminClient();
    await supabase.from('audit_logs').insert({
      action,
      entity,
      entity_id: entityId,
      user_id: userId,
      details: details || null,
    });
  } catch (err) {
    console.error('Error al escribir audit log:', err);
  }
}

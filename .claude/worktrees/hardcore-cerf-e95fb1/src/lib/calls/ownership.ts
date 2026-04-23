import type { AuthResult } from '@/lib/api/auth';
import { apiForbidden, apiNotFound } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';

type CallOwnershipRow = {
  id: string;
  twilio_call_sid: string | null;
  answered_by_user_id: string | null;
  twilio_data: Record<string, unknown> | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function collectOwnerIds(row: CallOwnershipRow): string[] {
  const owners = new Set<string>();

  if (isUuid(row.answered_by_user_id)) {
    owners.add(row.answered_by_user_id);
  }

  const data = row.twilio_data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [...owners];
  }

  const directKeys = [
    'resolved_agent_id',
    'requested_user_id',
    'user_id',
    'initiated_by',
    'answered_by_user_id',
  ];

  for (const key of directKeys) {
    const value = data[key];
    if (isUuid(value)) owners.add(value);
  }

  const metadata = data.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const metadataUserId = (metadata as Record<string, unknown>).user_id;
    if (isUuid(metadataUserId)) owners.add(metadataUserId);
  }

  return [...owners];
}

export async function requireCallControlPermission(
  auth: AuthResult,
  callSid: string,
): Promise<true | Response> {
  // M2M keys operate as trusted backend integrations.
  if (auth.authMethod === 'api_key') return true;
  if (auth.role === 'admin') return true;
  if (!auth.userId) {
    return apiForbidden('No se pudo resolver usuario de sesion para controlar la llamada');
  }

  const supabase = createAdminClient();

  // Buscar primero por twilio_call_sid directo
  let { data } = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, answered_by_user_id, twilio_data')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  // Si no se encuentra, buscar por agent_call_sid en twilio_data
  // (en conferencias, el widget envía el SID de la leg del agente, no el del caller)
  if (!data) {
    const { data: agentMatch } = await supabase
      .from('call_records')
      .select('id, twilio_call_sid, answered_by_user_id, twilio_data')
      .filter('twilio_data->>agent_call_sid', 'eq', callSid)
      .maybeSingle();
    data = agentMatch;
  }

  if (!data) return apiNotFound('Llamada');

  const ownershipRow = data as CallOwnershipRow;
  const ownerIds = collectOwnerIds(ownershipRow);

  if (ownerIds.includes(auth.userId)) {
    return true;
  }

  console.warn(
    `[CALL-CONTROL] Forbidden command user=${auth.userId} call_sid=${callSid} owners=${ownerIds.join(',') || '-'}`
  );
  return apiForbidden('No puedes ejecutar acciones sobre una llamada de otro agente');
}


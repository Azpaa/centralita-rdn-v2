import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import type { CallRecord, CallStatus, User } from '@/lib/types/database';

export type AgentOperationalStatus =
  | 'inactive'
  | 'unavailable'
  | 'ready'
  | 'ringing'
  | 'busy_in_call';

export type AgentActiveCall = {
  call_record_id: string;
  call_sid: string | null;
  direction: CallRecord['direction'];
  status: CallRecord['status'];
  from: string;
  to: string;
  started_at: string;
  answered_by_user_id: string | null;
  source: string | null;
  resolved_agent_id: string | null;
  conference_name: string | null;
};

export type AgentRuntimeSnapshot = {
  user_id: string;
  name: string;
  role: User['role'];
  active: boolean;
  available: boolean;
  rdn_user_id: string | null;
  operational_status: AgentOperationalStatus;
  active_calls_count: number;
  active_calls: AgentActiveCall[];
  generated_at: string;
  source_of_truth: 'backend_call_records';
};

const ACTIVE_STATUSES: Array<CallRecord['status']> = ['ringing', 'in_queue', 'in_progress'];
const TERMINAL_TWILIO_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const SELF_HEAL_MIN_AGE_MS = 30 * 1000;
const SELF_HEAL_MAX_CHECKS = 5;

type MinimalCallRecordRow = Pick<
  CallRecord,
  | 'id'
  | 'twilio_call_sid'
  | 'direction'
  | 'status'
  | 'from_number'
  | 'to_number'
  | 'started_at'
  | 'answered_by_user_id'
  | 'twilio_data'
>;

function getTextFromTwilioData(data: Record<string, unknown> | null, key: string): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapCallRecord(row: MinimalCallRecordRow): AgentActiveCall {
  return {
    call_record_id: row.id,
    call_sid: row.twilio_call_sid,
    direction: row.direction,
    status: row.status,
    from: row.from_number,
    to: row.to_number,
    started_at: row.started_at,
    answered_by_user_id: row.answered_by_user_id,
    source: getTextFromTwilioData(row.twilio_data, 'source'),
    resolved_agent_id: getTextFromTwilioData(row.twilio_data, 'resolved_agent_id'),
    conference_name: getTextFromTwilioData(row.twilio_data, 'conference_name'),
  };
}

function mapTerminalTwilioStatus(status: string): CallStatus {
  if (status === 'no-answer') return 'no_answer';
  return status as CallStatus;
}

async function reconcileStaleActiveCalls(
  rows: MinimalCallRecordRow[],
): Promise<MinimalCallRecordRow[]> {
  const nowMs = Date.now();
  const supabase = createAdminClient();
  const twilioClient = getTwilioClient();
  const staleIds = new Set<string>();

  const candidates = rows
    .filter((row) => {
      if (row.status !== 'in_progress') return false;
      if (!row.twilio_call_sid || row.twilio_call_sid.startsWith('pending-')) return false;
      const startedAtMs = Date.parse(row.started_at);
      return Number.isFinite(startedAtMs) && (nowMs - startedAtMs) >= SELF_HEAL_MIN_AGE_MS;
    })
    .slice(0, SELF_HEAL_MAX_CHECKS);

  for (const row of candidates) {
    const callSid = row.twilio_call_sid as string;

    try {
      const liveCall = await twilioClient.calls(callSid).fetch();
      const liveStatus = (liveCall.status || '').toLowerCase();
      if (!TERMINAL_TWILIO_STATUSES.has(liveStatus)) continue;

      const endedAt = liveCall.endTime
        ? new Date(liveCall.endTime).toISOString()
        : new Date().toISOString();
      const parsedDuration = parseInt(String(liveCall.duration ?? '0'), 10);
      const safeDuration = Number.isFinite(parsedDuration) ? parsedDuration : 0;

      await supabase
        .from('call_records')
        .update({
          status: mapTerminalTwilioStatus(liveStatus),
          ended_at: endedAt,
          duration: safeDuration,
        })
        .eq('id', row.id)
        .eq('status', 'in_progress')
        .is('ended_at', null);

      staleIds.add(row.id);
    } catch (err) {
      const errorCode = (err as { code?: number; status?: number })?.code;
      const errorStatus = (err as { code?: number; status?: number })?.status;
      const isNotFound = errorCode === 20404 || errorStatus === 404;
      if (!isNotFound) continue;

      await supabase
        .from('call_records')
        .update({
          status: 'canceled',
          ended_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'in_progress')
        .is('ended_at', null);

      staleIds.add(row.id);
    }
  }

  if (staleIds.size === 0) return rows;
  return rows.filter((row) => !staleIds.has(row.id));
}

export async function resolveAgentRuntimeSnapshot(userId: string): Promise<AgentRuntimeSnapshot | null> {
  const supabase = createAdminClient();

  const { data: userData } = await supabase
    .from('users')
    .select('id, name, role, active, available, rdn_user_id')
    .eq('id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!userData) return null;
  const user = userData as Pick<User, 'id' | 'name' | 'role' | 'active' | 'available' | 'rdn_user_id'>;

  // Main assignment source: answered_by_user_id
  const answeredCallsQuery = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, status, from_number, to_number, started_at, answered_by_user_id, twilio_data')
    .eq('answered_by_user_id', userId)
    .in('status', ACTIVE_STATUSES)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(25);

  // Secondary assignment source: resolved agent in twilio_data (RDN initiated/adopted)
  const resolvedAgentCallsQuery = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, status, from_number, to_number, started_at, answered_by_user_id, twilio_data')
    .eq('twilio_data->>resolved_agent_id', userId)
    .in('status', ACTIVE_STATUSES)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(25);

  // Fallback source for legacy browser-originated calls
  const initiatedCallsQuery = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, status, from_number, to_number, started_at, answered_by_user_id, twilio_data')
    .eq('twilio_data->>initiated_by', userId)
    .in('status', ACTIVE_STATUSES)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(25);

  // Ringing/in_queue calls currently targeted to this user (conference pre-answer routing).
  const targetedPendingCallsQuery = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, direction, status, from_number, to_number, started_at, answered_by_user_id, twilio_data')
    .in('status', ['ringing', 'in_queue'] as CallRecord['status'][])
    .is('ended_at', null)
    .contains('twilio_data', { current_ring_target_user_ids: [userId] })
    .order('started_at', { ascending: false })
    .limit(25);

  const rows = [
    ...(answeredCallsQuery.data || []),
    ...(resolvedAgentCallsQuery.data || []),
    ...(initiatedCallsQuery.data || []),
    ...(targetedPendingCallsQuery.data || []),
  ] as MinimalCallRecordRow[];

  const byId = new Map<string, MinimalCallRecordRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }

  const reconciledRows = await reconcileStaleActiveCalls([...byId.values()]);

  const activeCalls = reconciledRows
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, 25)
    .map(mapCallRecord);

  const hasInProgress = activeCalls.some((call) => call.status === 'in_progress');
  const hasRinging = activeCalls.some((call) => call.status === 'ringing' || call.status === 'in_queue');

  let operationalStatus: AgentOperationalStatus;
  if (!user.active) {
    operationalStatus = 'inactive';
  } else if (hasInProgress) {
    operationalStatus = 'busy_in_call';
  } else if (hasRinging) {
    operationalStatus = 'ringing';
  } else if (!user.available) {
    operationalStatus = 'unavailable';
  } else {
    operationalStatus = 'ready';
  }

  return {
    user_id: user.id,
    name: user.name,
    role: user.role,
    active: user.active,
    available: user.available,
    rdn_user_id: user.rdn_user_id,
    operational_status: operationalStatus,
    active_calls_count: activeCalls.length,
    active_calls: activeCalls,
    generated_at: new Date().toISOString(),
    source_of_truth: 'backend_call_records',
  };
}

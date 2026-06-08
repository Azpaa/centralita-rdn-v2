import { getTwilioClient } from '@/lib/twilio/client';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Shared leg-resolution helpers for call-control endpoints (hold/resume).
 *
 * Calls in this system have TWO possible topologies:
 *   - Inbound queue calls  → named conference `call-{callSid}` (caller + agent
 *     are independent conference participants).
 *   - Outbound calls       → `<Dial><Number>` bridge (agent = parent leg,
 *     destination = child leg).
 *
 * `hold`/`resume` historically only understood the parent/child topology, which
 * (a) failed to find the other leg for inbound conference calls and (b) DROPPED
 * outbound calls: redirecting the child out of the `<Dial>` ends the parent's
 * Dial, which then follows its `action` (dial-action) and hangs the agent up.
 *
 * These helpers mirror what `transfer`/`mute` already do: resolve the real legs
 * from the call_record (`agent_call_sid`) and from live Twilio conference
 * participants, falling back to parent/child only for genuine `<Dial>` bridges.
 */

export function normalizeSid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type CallRecordRef = {
  /** twilio_call_sid of the matched record (the canonical SID), or null. */
  recordSid: string | null;
  twilioData: Record<string, unknown>;
};

/**
 * Load a call_record by its canonical `twilio_call_sid`, falling back to a
 * match on `twilio_data.agent_call_sid` (the agent's media leg).
 */
export async function loadCallRecord(callSid: string): Promise<CallRecordRef> {
  const supabase = createAdminClient();

  let { data } = await supabase
    .from('call_records')
    .select('twilio_call_sid, twilio_data')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  if (!data) {
    const { data: byAgentSid } = await supabase
      .from('call_records')
      .select('twilio_call_sid, twilio_data')
      .filter('twilio_data->>agent_call_sid', 'eq', callSid)
      .maybeSingle();
    data = byAgentSid ?? null;
  }

  return {
    recordSid: normalizeSid(data?.twilio_call_sid),
    twilioData: asRecord(data?.twilio_data),
  };
}

/**
 * Read-merge-write a patch into a call_record's `twilio_data`. Passing `null`
 * for a key removes it (stored as null, which all readers treat as absent).
 */
export async function mergeTwilioData(
  recordSid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('call_records')
    .select('twilio_data')
    .eq('twilio_call_sid', recordSid)
    .maybeSingle();

  await supabase
    .from('call_records')
    .update({ twilio_data: { ...asRecord(data?.twilio_data), ...patch } })
    .eq('twilio_call_sid', recordSid);
}

export type ResolvedLegs = {
  /** Canonical call SID (record.twilio_call_sid) — inbound caller / outbound agent leg. */
  primaryCallSid: string | null;
  /** Agent media leg SID, when known (stored by agent-connect / client webhook). */
  agentCallSid: string | null;
  /** The "other party" leg to put on hold (caller for inbound, destination for outbound). */
  remoteCallSid: string | null;
  /** Live in-progress conference SID, when the call is conference-based. */
  conferenceSid: string | null;
  conferenceName: string | null;
  /** True when resolved via an active Twilio conference (use native participant hold). */
  isConference: boolean;
};

/**
 * Resolve the legs of an active call for hold/resume.
 *
 * Strategy (highest-confidence first):
 *   1. Active conference (`call-{sid}` or stored `conference_name`) → identify
 *      the remote participant via the live participant list.
 *   2. Parent/child fallback for outbound `<Dial>` bridges.
 */
export async function resolveHoldLegs(callSid: string): Promise<ResolvedLegs> {
  const client = getTwilioClient();
  const { recordSid, twilioData } = await loadCallRecord(callSid);

  const primaryCallSid = recordSid ?? normalizeSid(callSid);
  const agentCallSid = normalizeSid(twilioData.agent_call_sid);
  const storedConferenceName = normalizeSid(twilioData.conference_name);

  const result: ResolvedLegs = {
    primaryCallSid,
    agentCallSid,
    remoteCallSid: null,
    conferenceSid: null,
    conferenceName: null,
    isConference: false,
  };

  // 1) Active conference (inbound queue calls + already-resumed calls).
  const conferenceCandidates: string[] = [];
  for (const candidate of [
    storedConferenceName,
    primaryCallSid ? `call-${primaryCallSid}` : null,
    `call-${callSid}`,
  ]) {
    if (candidate && !conferenceCandidates.includes(candidate)) {
      conferenceCandidates.push(candidate);
    }
  }

  for (const name of conferenceCandidates) {
    try {
      const conferences = await client.conferences.list({
        friendlyName: name,
        status: 'in-progress',
        limit: 1,
      });
      if (conferences.length === 0) continue;

      const conference = conferences[0];
      const participants = await client.conferences(conference.sid).participants.list();
      if (participants.length === 0) continue;

      // The agent leg is whatever matches agent_call_sid (or the requested SID
      // when the caller addressed us by the agent leg). Everything else is the
      // remote party we want to hold.
      const agentSidCandidates = new Set<string>();
      if (agentCallSid) agentSidCandidates.add(agentCallSid);

      let remote: string | null = null;
      // Prefer the original caller as the remote party.
      if (
        primaryCallSid
        && primaryCallSid !== agentCallSid
        && participants.some((p) => p.callSid === primaryCallSid)
      ) {
        remote = primaryCallSid;
      }
      if (!remote) {
        const other = participants.find(
          (p) => !agentSidCandidates.has(p.callSid) && p.callSid !== callSid,
        );
        if (other) remote = other.callSid;
        else if (participants.length === 1) remote = participants[0].callSid;
      }

      result.conferenceSid = conference.sid;
      result.conferenceName = name;
      result.remoteCallSid = remote;
      result.isConference = true;
      return result;
    } catch {
      // Try the next candidate name.
    }
  }

  // 2) Parent/child fallback for outbound `<Dial>` bridges. The agent leg is the
  // parent (= primaryCallSid for outbound); its in-progress child is the remote.
  try {
    const inspectSid = agentCallSid || primaryCallSid || callSid;
    const info = await client.calls(inspectSid).fetch();
    if (info.parentCallSid) {
      result.remoteCallSid = info.parentCallSid;
    } else {
      const children = await client.calls.list({
        parentCallSid: inspectSid,
        status: 'in-progress',
        limit: 1,
      });
      if (children.length > 0) result.remoteCallSid = children[0].sid;
    }
  } catch {
    // Leave remoteCallSid null — caller handles "other leg not found".
  }

  return result;
}

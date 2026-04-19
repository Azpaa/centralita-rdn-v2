import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { createAdminClient } from '@/lib/supabase/admin';

type CallLookupRow = {
  twilio_call_sid: string | null;
  twilio_data: Record<string, unknown> | null;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    seen.add(normalized);
  }
  return [...seen];
}

async function resolveCallContext(callSid: string) {
  const supabase = createAdminClient();

  let { data } = await supabase
    .from('call_records')
    .select('twilio_call_sid, twilio_data')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  let matchedByAgentCallSid = false;

  if (!data) {
    const { data: byAgentSid } = await supabase
      .from('call_records')
      .select('twilio_call_sid, twilio_data')
      .filter('twilio_data->>agent_call_sid', 'eq', callSid)
      .maybeSingle();
    data = byAgentSid;
    matchedByAgentCallSid = Boolean(byAgentSid);
  }

  const row = (data as CallLookupRow | null) ?? null;
  const twilioData =
    row?.twilio_data && typeof row.twilio_data === 'object' && !Array.isArray(row.twilio_data)
      ? row.twilio_data
      : {};

  const primaryCallSid = normalizeString(row?.twilio_call_sid);
  const agentCallSid = normalizeString(twilioData.agent_call_sid);
  const storedConferenceName = normalizeString(twilioData.conference_name);

  const conferenceCandidates = uniqueStrings([
    storedConferenceName,
    primaryCallSid ? `call-${primaryCallSid}` : null,
    `call-${callSid}`,
  ]);

  const participantCandidates = matchedByAgentCallSid
    ? uniqueStrings([callSid, primaryCallSid, agentCallSid])
    : uniqueStrings([agentCallSid, callSid, primaryCallSid]);

  return {
    conferenceCandidates,
    participantCandidates,
    primaryCallSid,
    agentCallSid,
  };
}

/**
 * POST /api/v1/calls/:id/mute
 * Silencia a un participante dentro de una conferencia.
 *
 * Body: { conference_name: string }
 * - id: Twilio Call SID del participante a silenciar.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  let body: { conference_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    // body vacio permitido (se intentara deducir la conferencia)
  }

  const requestedConferenceName = normalizeString(body.conference_name);
  if (body.conference_name !== undefined && !requestedConferenceName) {
    return apiBadRequest('conference_name no puede estar vacio');
  }

  try {
    const client = getTwilioClient();
    const context = await resolveCallContext(callSid);

    const conferenceCandidates = uniqueStrings([
      requestedConferenceName,
      ...context.conferenceCandidates,
    ]);

    let resolvedConference:
      | {
          sid: string;
          friendlyName: string | null;
        }
      | null = null;
    let resolvedConferenceName: string | null = null;

    for (const conferenceName of conferenceCandidates) {
      const conferences = await client.conferences.list({
        friendlyName: conferenceName,
        status: 'in-progress',
        limit: 1,
      });
      if (conferences.length > 0) {
        resolvedConference = {
          sid: conferences[0].sid,
          friendlyName: conferences[0].friendlyName,
        };
        resolvedConferenceName = conferenceName;
        break;
      }
    }

    if (!resolvedConference) {
      return apiBadRequest(
        'Conferencia no encontrada para la llamada. El mute solo esta soportado para participantes en conferencia.',
        {
          call_sid: callSid,
          conference_candidates: conferenceCandidates,
        }
      );
    }

    const participants = await client
      .conferences(resolvedConference.sid)
      .participants.list();

    let targetParticipant:
      | {
          callSid: string;
        }
      | undefined;

    for (const participantSid of context.participantCandidates) {
      targetParticipant = participants.find((participant) => participant.callSid === participantSid);
      if (targetParticipant) break;
    }

    const target = targetParticipant;
    if (!target) {
      return apiBadRequest('Participante no encontrado en la conferencia', {
        call_sid: callSid,
        participant_candidates: context.participantCandidates,
        conference: resolvedConferenceName || resolvedConference.friendlyName,
      });
    }

    await client
      .conferences(resolvedConference.sid)
      .participants(target.callSid)
      .update({ muted: true });

    await auditLog('call.mute', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      conference_name: resolvedConferenceName || resolvedConference.friendlyName,
      requested_conference_name: requestedConferenceName,
      target_participant_call_sid: target.callSid,
      primary_call_sid: context.primaryCallSid,
      agent_call_sid: context.agentCallSid,
      auth_method: auth.authMethod,
    });

    return apiSuccess({
      muted: true,
      callSid: target.callSid,
      requested_call_sid: callSid,
      conference: resolvedConferenceName || resolvedConference.friendlyName,
    });
  } catch (err) {
    console.error(`[MUTE] Error muting ${callSid}:`, err);
    return apiInternalError('Error al silenciar');
  }
}

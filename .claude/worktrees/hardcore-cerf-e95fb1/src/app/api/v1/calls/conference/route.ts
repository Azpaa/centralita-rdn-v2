import { NextRequest } from 'next/server';
import crypto from 'crypto';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { publishCanonicalClientEvent } from '@/lib/events/client-stream';

/**
 * POST /api/v1/calls/conference
 * Gestiona conferencias para llamadas a 3 vías.
 *
 * Actions:
 * - "create": Mueve la llamada actual a una conferencia
 * - "add": Añade un participante a la conferencia existente
 * - "leave": El agente sale de la conferencia dejando a los otros conectados
 * - "kick": Expulsa a un participante de la conferencia
 *
 * Body: { action, conferenceName, callSid?, destination?, callerId?, participantSid? }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: {
    action?: string;
    conferenceName?: string;
    callSid?: string;
    destination?: string;
    callerId?: string;
    participantSid?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const { action, conferenceName, callSid, destination, callerId, participantSid } = body;
  if (!action) return apiBadRequest('action es requerido');

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const client = getTwilioClient();

  try {
    const publishConferenceUpdated = (payload: Record<string, unknown>) => {
      publishCanonicalClientEvent({
        id: crypto.randomUUID(),
        type: 'conference_updated',
        timestamp: new Date().toISOString(),
        call_sid: typeof payload.call_sid === 'string' ? payload.call_sid : null,
        agent_user_id: auth.userId ?? null,
        target_user_ids: auth.userId ? [auth.userId] : [],
        payload,
      });
    };

    switch (action) {
      case 'create': {
        // Mover una llamada existente a una conferencia.
        // El callSid es la leg del browser — necesitamos resolver la leg remota
        // para meter a ambas partes en la conferencia.
        if (!callSid || !conferenceName) {
          return apiBadRequest('callSid y conferenceName son requeridos para create');
        }

        const permissionCheck = await requireCallControlPermission(auth, callSid);
        if (permissionCheck !== true) return permissionCheck;

        // Resolver la leg del interlocutor remoto
        const callInfo = await client.calls(callSid).fetch();
        let remoteSid: string | null = null;

        if (callInfo.parentCallSid) {
          // Entrante: browser es child, remoto es parent
          remoteSid = callInfo.parentCallSid;
        } else {
          // Saliente: browser es parent, remoto es child
          const children = await client.calls.list({
            parentCallSid: callSid,
            status: 'in-progress',
            limit: 1,
          });
          if (children.length > 0) remoteSid = children[0].sid;
        }

        // Construir TwiML inline para unirse a la conferencia
        const confTwiml = new twilio.twiml.VoiceResponse();
        const confDial = confTwiml.dial();
        confDial.conference(
          {
            startConferenceOnEnter: true,
            endConferenceOnExit: false,
            waitUrl: `${baseUrl}/api/webhooks/twilio/voice/wait-silence`,
          },
          conferenceName
        );
        const confTwimlStr = confTwiml.toString();

        // Redirigir ambas legs a la conferencia con TwiML inline (en paralelo)
        const redirects: Promise<unknown>[] = [];
        if (remoteSid) {
          redirects.push(
            client.calls(remoteSid).update({ twiml: confTwimlStr })
          );
        }
        redirects.push(
          client.calls(callSid).update({ twiml: confTwimlStr })
        );
        await Promise.all(redirects);

        await auditLog('call.conference', 'call_record', callSid, auth.userId, {
          action: 'create',
          conference_name: conferenceName,
          remote_call_sid: remoteSid,
          auth_method: auth.authMethod,
        });

        publishConferenceUpdated({
          action: 'create',
          conference_name: conferenceName,
          call_sid: callSid,
          remote_call_sid: remoteSid,
        });

        return apiSuccess({ conferenceName, callSid, remoteSid });
      }

      case 'add': {
        // Añadir un nuevo participante llamándole desde la conferencia
        if (!conferenceName || !destination) {
          return apiBadRequest('conferenceName y destination son requeridos para add');
        }

        // Usar Twilio para crear una llamada que entre a la conferencia
        const participantCallerId = callerId || '';

        // Buscar la conferencia activa
        const conferences = await client.conferences.list({
          friendlyName: conferenceName,
          status: 'in-progress',
          limit: 1,
        });

        if (conferences.length === 0) {
          return apiBadRequest('Conferencia no encontrada o no está activa');
        }

        const conf = conferences[0];

        // Añadir participante a la conferencia
        let to = destination;
        if (destination.startsWith('client:')) {
          to = destination; // Twilio acepta "client:identity" directamente
        }

        const participant = await client.conferences(conf.sid)
          .participants
          .create({
            from: participantCallerId,
            to,
            statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          });

        await auditLog('call.conference', 'call_record', null, auth.userId, {
          action: 'add',
          conference_name: conferenceName,
          destination,
          participant_sid: participant.callSid,
          auth_method: auth.authMethod,
        });

        publishConferenceUpdated({
          action: 'add',
          conference_name: conferenceName,
          destination,
          participant_sid: participant.callSid,
        });

        return apiSuccess({
          conferenceName,
          participantSid: participant.callSid,
          conferenceSid: conf.sid,
        });
      }

      case 'leave': {
        // El agente sale de la conferencia dejando a los otros conectados
        if (!conferenceName || !participantSid) {
          return apiBadRequest('conferenceName y participantSid son requeridos para leave');
        }

        const permissionCheck = await requireCallControlPermission(auth, participantSid);
        if (permissionCheck !== true) return permissionCheck;

        const conferences = await client.conferences.list({
          friendlyName: conferenceName,
          status: 'in-progress',
          limit: 1,
        });

        if (conferences.length === 0) {
          return apiBadRequest('Conferencia no encontrada');
        }

        // Eliminar al agente de la conferencia
        await client.conferences(conferences[0].sid)
          .participants(participantSid)
          .remove();

        await auditLog('call.conference', 'call_record', participantSid, auth.userId, {
          action: 'leave',
          conference_name: conferenceName,
          participant_sid: participantSid,
          auth_method: auth.authMethod,
        });

        publishConferenceUpdated({
          action: 'leave',
          conference_name: conferenceName,
          participant_sid: participantSid,
          call_sid: participantSid,
        });

        return apiSuccess({ left: true, conferenceName });
      }

      case 'kick': {
        // Expulsar a un participante específico
        if (!conferenceName || !participantSid) {
          return apiBadRequest('conferenceName y participantSid son requeridos para kick');
        }

        const permissionCheck = await requireCallControlPermission(auth, participantSid);
        if (permissionCheck !== true) return permissionCheck;

        const conferences = await client.conferences.list({
          friendlyName: conferenceName,
          status: 'in-progress',
          limit: 1,
        });

        if (conferences.length === 0) {
          return apiBadRequest('Conferencia no encontrada');
        }

        await client.conferences(conferences[0].sid)
          .participants(participantSid)
          .remove();

        await auditLog('call.conference', 'call_record', participantSid, auth.userId, {
          action: 'kick',
          conference_name: conferenceName,
          participant_sid: participantSid,
          auth_method: auth.authMethod,
        });

        publishConferenceUpdated({
          action: 'kick',
          conference_name: conferenceName,
          participant_sid: participantSid,
          call_sid: participantSid,
        });

        return apiSuccess({ kicked: true, participantSid });
      }

      default:
        return apiBadRequest(`Acción desconocida: ${action}`);
    }
  } catch (err) {
    console.error(`[CONFERENCE] Error (${action}):`, err);
    return apiInternalError('Error gestionando conferencia');
  }
}


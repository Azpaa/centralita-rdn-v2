import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

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
    switch (action) {
      case 'create': {
        // Mover una llamada existente a una conferencia
        if (!callSid || !conferenceName) {
          return apiBadRequest('callSid y conferenceName son requeridos para create');
        }

        // Redirigir la llamada del interlocutor a la conferencia
        await client.calls(callSid).update({
          url: `${baseUrl}/api/webhooks/twilio/voice/conference-join?room=${encodeURIComponent(conferenceName)}&role=participant`,
          method: 'POST',
        });

        return apiSuccess({ conferenceName, callSid });
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

        return apiSuccess({ left: true, conferenceName });
      }

      case 'kick': {
        // Expulsar a un participante específico
        if (!conferenceName || !participantSid) {
          return apiBadRequest('conferenceName y participantSid son requeridos para kick');
        }

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

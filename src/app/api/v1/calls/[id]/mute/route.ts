import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/:id/mute
 * Silencia el audio de una llamada (el participante no puede oír al otro lado).
 *
 * Nota: El mute vía REST API de Twilio solo funciona para participantes en
 * conferencias. Para llamadas normales, el mute se controla desde el SDK
 * del navegador (call.mute()). Este endpoint es para conferencias.
 *
 * Body (opcional): { target?: 'agent' | 'remote', conference_name: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  let body: { target?: string; conference_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío OK
  }

  try {
    const client = getTwilioClient();

    // Si hay nombre de conferencia, mutear al participante en la conferencia
    if (body.conference_name) {
      const conferences = await client.conferences.list({
        friendlyName: body.conference_name,
        status: 'in-progress',
        limit: 1,
      });

      if (conferences.length === 0) {
        return apiBadRequest('Conferencia no encontrada');
      }

      // Buscar al participante por callSid
      const participants = await client
        .conferences(conferences[0].sid)
        .participants.list();

      const target = participants.find(p => p.callSid === callSid);
      if (!target) {
        return apiBadRequest('Participante no encontrado en la conferencia');
      }

      await client
        .conferences(conferences[0].sid)
        .participants(target.callSid)
        .update({ muted: true });

      return apiSuccess({ muted: true, callSid, conference: body.conference_name });
    }

    // Sin conferencia: indicar que debe usarse el SDK del navegador
    return apiBadRequest(
      'El mute para llamadas directas (no en conferencia) se controla desde el SDK del navegador. ' +
      'Para mutear en conferencia, incluye conference_name en el body.'
    );
  } catch (err) {
    console.error(`[MUTE] Error muting ${callSid}:`, err);
    return apiInternalError('Error al silenciar');
  }
}

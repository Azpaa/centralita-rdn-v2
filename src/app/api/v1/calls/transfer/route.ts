import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/transfer
 * Transferencia en frío: redirige la llamada activa a otro destino.
 * El agente se desconecta y la llamada pasa directamente al nuevo destino.
 *
 * Body: { callSid: string, destination: string, callerId?: string }
 *   - callSid: SID de la llamada a transferir (la child leg del <Dial>)
 *   - destination: número de teléfono o "client:<userId>" 
 *   - callerId: caller ID para la nueva llamada
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: { callSid?: string; destination?: string; callerId?: string };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const { callSid, destination, callerId } = body;
  if (!callSid || !destination) {
    return apiBadRequest('callSid y destination son requeridos');
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const client = getTwilioClient();

    // Redirigir la llamada padre (del caller original) a un nuevo TwiML
    // que hace <Dial> al nuevo destino
    const transferUrl = `${baseUrl}/api/webhooks/twilio/voice/transfer-connect` +
      `?destination=${encodeURIComponent(destination)}` +
      `&caller_id=${encodeURIComponent(callerId || '')}`;

    await client.calls(callSid).update({
      url: transferUrl,
      method: 'POST',
    });

    return apiSuccess({ transferred: true, callSid, destination });
  } catch (err) {
    console.error('[TRANSFER] Error:', err);
    return apiInternalError('Error al transferir la llamada');
  }
}

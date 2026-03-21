import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/hold
 * Pone o saca una llamada de espera.
 * En Twilio, "hold" = redirigir la leg del interlocutor a TwiML con <Play> música.
 * "Unhold" = redirigir de vuelta a la conferencia o al agente.
 *
 * Body: { callSid: string, hold: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: { callSid?: string; hold?: boolean };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const { callSid, hold } = body;
  if (!callSid || hold === undefined) {
    return apiBadRequest('callSid y hold son requeridos');
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const client = getTwilioClient();

    if (hold) {
      // Redirigir la llamada a un TwiML que toca música de espera en bucle
      await client.calls(callSid).update({
        url: `${baseUrl}/api/webhooks/twilio/voice/hold-music`,
        method: 'POST',
      });
    } else {
      // Para sacar de hold, el front-end debe reconectar la llamada
      // Esto se maneja a nivel del widget — al sacar de hold,
      // la llamada ya está en una conferencia y simplemente se hace unmute
      // o se redirige de vuelta
      await client.calls(callSid).update({
        url: `${baseUrl}/api/webhooks/twilio/voice/hold-music?unhold=true`,
        method: 'POST',
      });
    }

    return apiSuccess({ callSid, hold });
  } catch (err) {
    console.error('[HOLD] Error:', err);
    return apiInternalError('Error al poner/sacar de espera');
  }
}

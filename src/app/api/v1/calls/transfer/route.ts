import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/transfer
 * Transferencia en frío: redirige la llamada activa a otro destino.
 * El agente se desconecta y la llamada pasa directamente al nuevo destino.
 *
 * IMPORTANTE: El front-end envía el CallSid del agente (la leg del browser).
 * Para transferir correctamente, necesitamos redirigir la leg del llamante original,
 * NO la del agente. Usamos la API de Twilio para obtener la llamada padre.
 *
 * Body: { callSid: string, destination: string, callerId?: string }
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

    // Obtener la llamada para encontrar la leg correcta.
    // El callSid del browser puede ser la leg hija (para entrantes) o la leg padre (para salientes).
    // Para transferir, necesitamos redirigir la leg del llamante original.
    const callInfo = await client.calls(callSid).fetch();
    let parentCallSid = callSid;

    if (callInfo.parentCallSid) {
      // Esta es una child leg (típico de entrantes) → redirigir la parent leg
      parentCallSid = callInfo.parentCallSid;
    } else {
      // Esta es la parent call (típico de salientes del browser).
      // Necesitamos encontrar las child legs y redirigir la que conecta con el destino.
      // Listamos las child calls activas
      const childCalls = await client.calls.list({
        parentCallSid: callSid,
        status: 'in-progress',
        limit: 5,
      });

      if (childCalls.length > 0) {
        // Redirigir la llamada padre (la del browser) para que se conecte al nuevo destino.
        // Las child legs se cerrarán automáticamente.
        parentCallSid = callSid;
      }
    }

    console.log(`[TRANSFER] Agent SID=${callSid} → Redirecting parent SID=${parentCallSid} to ${destination}`);

    // Redirigir la llamada padre al TwiML de transferencia
    const transferUrl = `${baseUrl}/api/webhooks/twilio/voice/transfer-connect` +
      `?destination=${encodeURIComponent(destination)}` +
      `&caller_id=${encodeURIComponent(callerId || '')}`;

    await client.calls(parentCallSid).update({
      url: transferUrl,
      method: 'POST',
    });

    return apiSuccess({ transferred: true, callSid: parentCallSid, destination });
  } catch (err) {
    console.error('[TRANSFER] Error:', err);
    return apiInternalError('Error al transferir la llamada');
  }
}

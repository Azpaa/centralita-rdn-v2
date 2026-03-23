import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/transfer
 * Transferencia en frío (blind transfer).
 *
 * Flujo:
 *  1. Identificar la leg remota (la persona con la que habla el agente).
 *  2. Enviarle TwiML **inline** (parámetro `twiml`) que dice "Transfiriendo…"
 *     y hace <Dial> al nuevo destino.  Sin action URL → al terminar el Dial
 *     la llamada simplemente se despide y cuelga.
 *  3. Colgar explícitamente la leg del agente.
 *
 * ¿Por qué TwiML inline en vez de redirigir a un webhook?
 *  • Evita problemas de firma (401) detrás de reverse-proxy / Cloudflare.
 *  • Evita que dial-action reprocesse la llamada y reintente la cola
 *    (era el bug: "me cuelga y me vuelve a llamar").
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

  try {
    const client = getTwilioClient();

    // ── 1. Identificar la leg remota ──────────────────────────────────────
    const callInfo = await client.calls(callSid).fetch();
    let remoteCallSid: string;

    if (callInfo.parentCallSid) {
      // callSid es child (entrante) → remoto = parent (el llamante externo)
      remoteCallSid = callInfo.parentCallSid;
    } else {
      // callSid es parent (saliente browser) → remoto = child (persona llamada)
      const children = await client.calls.list({
        parentCallSid: callSid,
        status: 'in-progress',
        limit: 5,
      });

      if (children.length === 0) {
        return apiBadRequest(
          'No se encontró la otra parte de la llamada. Puede que ya haya colgado.'
        );
      }
      remoteCallSid = children[0].sid;
    }

    console.log(
      `[TRANSFER] agentSid=${callSid} remoteSid=${remoteCallSid} → ${destination}`
    );

    // ── 2. Construir TwiML inline para la transferencia ──────────────────
    const twimlBuilder = new twilio.twiml.VoiceResponse();

    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Transfiriendo su llamada. Un momento por favor.'
    );

    // <Dial> SIN action URL → al finalizar el Dial, la llamada continúa
    // con los siguientes verbos (despedida + hangup). Así evitamos que
    // dial-action reintente la cola.
    const dial = twimlBuilder.dial({
      callerId: callerId || undefined,
      timeout: 30,
    });

    if (destination.startsWith('client:')) {
      dial.client(destination.replace('client:', ''));
    } else {
      dial.number(destination);
    }

    // Después del Dial (conteste o no), despedirse y colgar.
    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'La transferencia ha finalizado. Gracias por llamar.'
    );
    twimlBuilder.hangup();

    const twimlString = twimlBuilder.toString();

    // ── 3. Redirigir la leg remota con TwiML inline ──────────────────────
    await client.calls(remoteCallSid).update({ twiml: twimlString });

    // ── 4. Colgar la leg del agente explícitamente ───────────────────────
    // Para entrantes: el child (agente) se desconecta automáticamente al
    //   interrumpir el Dial del parent, pero lo completamos por seguridad.
    // Para salientes: evitamos que el parent vaya a dial-action (que podría
    //   reintentar colas o mostrar errores de webhook 401).
    try {
      await client.calls(callSid).update({ status: 'completed' });
    } catch {
      // Ya estaba desconectado — OK
    }

    return apiSuccess({ transferred: true, callSid: remoteCallSid, destination });
  } catch (err) {
    console.error('[TRANSFER] Error:', err);
    return apiInternalError('Error al transferir la llamada');
  }
}

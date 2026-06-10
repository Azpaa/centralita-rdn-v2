import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { loadCallRecord } from '@/lib/calls/leg-resolution';

/**
 * POST /api/webhooks/twilio/voice/hold-park
 *
 * Aparcamiento RENOVABLE de la leg del agente durante un hold saliente
 * (`<Dial>`). Antes dial-action aparcaba con un único `<Pause length=3600>`:
 * a la hora exacta el TwiML se agotaba y Twilio colgaba la leg del agente,
 * dejando al cliente atrapado en el bucle de música (zombi).
 *
 * Ahora dial-action aparca con pausas cortas que redirigen aquí; en cada
 * vuelta se re-lee el estado de hold del call_record:
 *  - hold activo y dentro del máximo → otra pausa.
 *  - hold desactivado (resume falló a medias u otro estado raro; el resume
 *    normal redirige esta leg y nunca pasa por aquí) → colgar con aviso.
 *  - máximo superado → colgar con aviso; el lado del cliente tiene su
 *    propio tope en wait-silence, así que ambas legs mueren acotadas y el
 *    registro se cierra por los status callbacks de siempre.
 */

const PARK_SLICE_SECONDS = 240;
const MAX_PARK_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest) {
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const callSid = params.CallSid || '';
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const { twilioData } = await loadCallRecord(callSid);
    const hold =
      twilioData.hold && typeof twilioData.hold === 'object' && !Array.isArray(twilioData.hold)
        ? (twilioData.hold as Record<string, unknown>)
        : null;

    const held = hold?.held === true;
    const heldAtMs = typeof hold?.at === 'string' ? Date.parse(hold.at) : NaN;
    const heldForMs = Number.isFinite(heldAtMs) ? Date.now() - heldAtMs : Number.POSITIVE_INFINITY;

    if (!held) {
      console.warn(
        `[HOLD-PARK] Leg ${callSid} aparcada sin hold activo (¿resume a medias?) — colgando.`
      );
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'La espera ha finalizado.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    if (heldForMs >= MAX_PARK_MS) {
      console.warn(
        `[HOLD-PARK] Hold de ${callSid} superó el máximo (${Math.round(heldForMs / 60000)} min) — liberando la leg del agente.`
      );
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'La espera ha superado el tiempo máximo y la llamada se va a finalizar.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    twiml.pause({ length: PARK_SLICE_SECONDS });
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/hold-park`);
    return twimlResponse(twiml);
  } catch (err) {
    console.error(`[HOLD-PARK] Error renovando aparcamiento de ${callSid}:`, err);
    // Ante la duda, una pausa más en vez de colgar una llamada recuperable.
    twiml.pause({ length: PARK_SLICE_SECONDS });
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/hold-park`);
    return twimlResponse(twiml);
  }
}

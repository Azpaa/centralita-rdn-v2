import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { parseTwilioBody } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/dial-action
 * Twilio llama aquí cuando un <Dial> termina (el operador cuelga o no contesta).
 * Decide qué hacer después: colgar, reenviar a otro, buzón de voz, etc.
 *
 * Parámetros de Twilio:
 * - DialCallStatus: completed | busy | no-answer | failed | canceled
 * - DialCallSid, DialCallDuration
 * - CallSid (del caller original)
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const params = parseTwilioBody(body);

  const callSid = params.CallSid || '';
  const dialStatus = params.DialCallStatus || '';
  const dialDuration = params.DialCallDuration ? parseInt(params.DialCallDuration, 10) : 0;

  console.log(`[DIAL-ACTION] CallSid=${callSid} DialStatus=${dialStatus} Duration=${dialDuration}s`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Si la llamada fue contestada y completada, no hay nada más que hacer
  if (dialStatus === 'completed') {
    await updateCallStatus(callSid, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      duration: dialDuration,
    });
    twiml.hangup();
    return twimlResponse(twiml);
  }

  // Si no contestó, está ocupado o falló
  const statusMap: Record<string, string> = {
    busy: 'busy',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'canceled',
  };

  await updateCallStatus(callSid, {
    status: statusMap[dialStatus] || 'no_answer',
    endedAt: new Date().toISOString(),
  });

  // Mensaje de despedida
  if (dialStatus === 'busy') {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'La línea está ocupada. Por favor, inténtelo más tarde.'
    );
  } else if (dialStatus === 'no-answer') {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'No ha sido posible conectar su llamada. Por favor, inténtelo más tarde.'
    );
  } else {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'No ha sido posible completar su llamada.'
    );
  }

  twiml.hangup();
  return twimlResponse(twiml);
}

function twimlResponse(twiml: twilio.twiml.VoiceResponse): NextResponse {
  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

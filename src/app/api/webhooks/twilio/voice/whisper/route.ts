import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { parseTwilioBody } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/whisper
 * Se ejecuta cuando el operador descuelga, ANTES de conectarle con el caller.
 * Sirve para:
 * 1. Anunciar al operador de qué va la llamada
 * 2. Registrar quién contestó en la DB
 *
 * Query params: operator_id, call_sid
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const params = parseTwilioBody(body);
  const { searchParams } = new URL(req.url);

  const operatorId = searchParams.get('operator_id') || '';
  const parentCallSid = searchParams.get('call_sid') || '';
  const from = params.From || 'desconocido';

  console.log(`[WHISPER] Operator=${operatorId} CallSid=${parentCallSid} From=${from}`);

  // Registrar quién contestó
  if (parentCallSid && operatorId) {
    try {
      await updateCallStatus(parentCallSid, {
        status: 'in_progress',
        answeredAt: new Date().toISOString(),
        answeredByUserId: operatorId,
      });
    } catch (err) {
      console.error('[WHISPER] Error updating call record:', err);
    }
  }

  // TwiML: breve anuncio al operador
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    `Llamada entrante.`
  );

  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

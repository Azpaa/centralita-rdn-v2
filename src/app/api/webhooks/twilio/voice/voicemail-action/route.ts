import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { parseTwilioBody } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/voicemail-action
 * Se ejecuta cuando el caller termina de dejar un mensaje de voz.
 * La grabación se procesa por el webhook de recording/status.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const params = parseTwilioBody(body);

  console.log(`[VOICEMAIL] CallSid=${params.CallSid} RecordingSid=${params.RecordingSid}`);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Gracias por su mensaje. Le contactaremos lo antes posible.'
  );
  twiml.hangup();

  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';

/**
 * POST /api/webhooks/twilio/voice/fallback
 * Twilio llama aquí si el webhook principal falla.
 * Respuesta de emergencia.
 */
export async function POST(req: NextRequest) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Lo sentimos, estamos experimentando dificultades técnicas. Por favor, inténtelo más tarde.'
  );
  twiml.hangup();

  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

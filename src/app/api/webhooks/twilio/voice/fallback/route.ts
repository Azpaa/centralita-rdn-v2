import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateTwilioWebhookLight, twimlResponse } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/fallback
 * Twilio llama aquí si el webhook principal falla.
 * Respuesta de emergencia.
 */
export async function POST(req: NextRequest) {
  // Validar firma de Twilio
  const validation = await validateTwilioWebhookLight(req);
  if (validation !== true) return validation;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Lo sentimos, estamos experimentando dificultades técnicas. Por favor, inténtelo más tarde.'
  );
  twiml.hangup();

  return twimlResponse(twiml);
}

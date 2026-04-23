import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateTwilioWebhookLight, twimlResponse } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/conference-join
 * TwiML que mete a un participante en una conferencia.
 */
export async function POST(req: NextRequest) {
  // Validar firma de Twilio
  const validation = await validateTwilioWebhookLight(req);
  if (validation !== true) return validation;

  const { searchParams } = new URL(req.url);
  const room = searchParams.get('room') || 'default-room';
  const role = searchParams.get('role') || 'participant';

  console.log(`[CONFERENCE-JOIN] Room=${room} Role=${role}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: role === 'moderator', // Si el moderador sale, termina la conferencia
      waitUrl: `${baseUrl}/api/webhooks/twilio/voice/wait-silence`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackEvent: ['start', 'end', 'join', 'leave'],
    },
    room
  );

  return twimlResponse(twiml);
}

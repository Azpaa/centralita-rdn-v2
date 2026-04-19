import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateTwilioWebhookLight, twimlResponse } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/outbound-connect
 * TwiML that Twilio executes when an outbound call is answered by the destination.
 * For direct-to-destination calls, just keeps the line open (no extra actions needed).
 */
export async function POST(req: NextRequest) {
  const validation = await validateTwilioWebhookLight(req);
  if (validation !== true) return validation;

  const { searchParams } = new URL(req.url);
  const callerId = searchParams.get('caller_id') || '';

  console.log(`[OUTBOUND-CONNECT] Call answered, caller_id=${callerId}`);

  // The call is already connected to the destination.
  // Just return empty TwiML to keep the line open.
  const twiml = new twilio.twiml.VoiceResponse();
  return twimlResponse(twiml);
}

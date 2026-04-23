import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateTwilioWebhookLight, twimlResponse } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/outbound-connect
 *
 * TwiML webhook called when the agent answers the outbound call in the desktop app.
 * If a `destination` query param is present, we generate <Dial> to bridge the
 * agent with the destination phone number. The agent hears ringing, then the
 * client picks up and they can talk normally.
 *
 * Flow:
 *  1. RDN calls POST /api/v1/calls/dial  →  Twilio calls client:<agent_id>
 *  2. Agent answers in desktop app  →  Twilio fetches THIS webhook
 *  3. We return <Dial><Number>destination</Number></Dial>
 *  4. Twilio calls the destination and bridges both legs  →  normal conversation
 */
export async function POST(req: NextRequest) {
  const validation = await validateTwilioWebhookLight(req);
  if (validation !== true) return validation;

  const { searchParams } = new URL(req.url);
  const callerId = searchParams.get('caller_id') || '';
  const destination = searchParams.get('destination') || '';
  const userId = searchParams.get('user_id') || '';
  const source = searchParams.get('source') || '';

  console.log(
    `[OUTBOUND-CONNECT] Agent answered in desktop app. caller_id=${callerId} destination=${destination} user_id=${userId} source=${source}`
  );

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  // Check if recording is enabled for this caller number
  let shouldRecord = false;
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const supabase = createAdminClient();
    const { data: phoneNum } = await supabase
      .from('phone_numbers')
      .select('record_calls')
      .eq('phone_number', callerId)
      .single();

    shouldRecord = phoneNum?.record_calls ?? false;
  } catch {
    // Ignore error, don't record
  }

  if (destination) {
    // Agent answered — now bridge them with the destination number.
    console.log(
      `[OUTBOUND-CONNECT] Bridging agent to destination ${destination} with callerId ${callerId}`
    );

    const dial = twiml.dial({
      callerId: callerId,
      timeout: 60,
      action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      record: shouldRecord ? 'record-from-answer-dual' as const : 'do-not-record' as const,
      recordingStatusCallback: shouldRecord
        ? `${baseUrl}/api/webhooks/twilio/recording/status`
        : undefined,
    });
    dial.number(
      {
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      },
      destination
    );
  } else {
    // Legacy flow (no destination): call was made directly to PSTN,
    // just keep the line open.
    console.log(`[OUTBOUND-CONNECT] No destination param — legacy direct PSTN flow`);
    twiml.pause({ length: 3600 });
  }

  return twimlResponse(twiml);
}

import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateTwilioWebhookLight, twimlResponse } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/outbound-connect
 * TwiML que Twilio ejecuta cuando se inicia una llamada saliente.
 * Mantiene la llamada abierta y opcionalmente graba.
 */
export async function POST(req: NextRequest) {
  // Validar firma de Twilio
  const validation = await validateTwilioWebhookLight(req);
  if (validation !== true) return validation;
  const { searchParams } = new URL(req.url);
  const callerId = searchParams.get('caller_id') || '';
  const destination = searchParams.get('destination') || '';
  const userId = searchParams.get('user_id') || '';
  const source = searchParams.get('source') || '';

  console.log(`[OUTBOUND-CONNECT] Agent answered, caller_id=${callerId} destination=${destination} user_id=${userId} source=${source}`);

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

  if (shouldRecord) {
    // For legacy (no destination) calls, use standalone Record
    if (!destination) {
      twiml.record({
        recordingStatusCallback: `${baseUrl}/api/webhooks/twilio/recording/status`,
        recordingStatusCallbackEvent: ['completed'],
      });
    }
    // For agent-attached calls, recording goes on the <Dial> verb below
  }

  // If there's a destination, dial it now (agent-attached outbound flow).
  // The agent already picked up their phone; now we connect them to the target.
  if (destination) {
    console.log(`[OUTBOUND-CONNECT] Connecting agent to destination ${destination} via caller_id ${callerId}`);
    const dialOpts: Record<string, unknown> = {
      callerId: callerId,
      timeout: 60,
      action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
    };
    if (shouldRecord) {
      dialOpts.record = 'record-from-answer-dual';
      dialOpts.recordingStatusCallback = `${baseUrl}/api/webhooks/twilio/recording/status`;
      dialOpts.recordingStatusCallbackEvent = 'completed';
    }
    const dial = twiml.dial(dialOpts);
    dial.number(destination);
  } else {
    // Legacy flow: no destination, call was made directly to PSTN.
    // Just keep the line open.
    console.log(`[OUTBOUND-CONNECT] No destination param, legacy direct flow`);
  }

  return twimlResponse(twiml);
}

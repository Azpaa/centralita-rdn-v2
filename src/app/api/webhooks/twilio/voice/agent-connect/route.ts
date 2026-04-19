import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { User } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/agent-connect
 *
 * Called when an agent answers the REST-API-initiated call to their Device
 * (or phone). This handler:
 *  1. Plays a brief whisper to the agent
 *  2. Puts the agent into the conference where the caller is waiting
 *
 * Query params:
 *   - conference: name of the conference room (e.g. "call-{callSid}")
 *   - call_sid: parent call SID for the inbound call
 *   - operator_id: agent's user ID
 */
export async function POST(req: NextRequest) {
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const { searchParams } = new URL(req.url);
  const conferenceName = searchParams.get('conference') || '';
  const parentCallSid = searchParams.get('call_sid') || '';
  const operatorId = searchParams.get('operator_id') || '';
  const agentCallSid = params.CallSid || ''; // SID de la leg del agente (browser/phone)

  console.log(
    `[AGENT-CONNECT] Agent answered. conference=${conferenceName} callSid=${parentCallSid} operatorId=${operatorId} agentLeg=${agentCallSid}`
  );

  // Update call record: agent answered
  if (parentCallSid && operatorId) {
    try {
      await updateCallStatus(parentCallSid, {
        status: 'in_progress',
        answeredAt: new Date().toISOString(),
        answeredByUserId: operatorId,
      });

      // Guardar el SID de la leg del agente en twilio_data para lookups inversos
      // (transfer, hangup, etc. reciben el agentCallSid y necesitan encontrar el original)
      const supabase = createAdminClient();
      if (agentCallSid) {
        const { data: existing } = await supabase
          .from('call_records')
          .select('twilio_data')
          .eq('twilio_call_sid', parentCallSid)
          .single();
        const merged = { ...((existing?.twilio_data as Record<string, unknown>) || {}), agent_call_sid: agentCallSid };
        await supabase
          .from('call_records')
          .update({ twilio_data: merged })
          .eq('twilio_call_sid', parentCallSid);
        console.log(`[AGENT-CONNECT] Stored agent_call_sid=${agentCallSid} in call_record ${parentCallSid}`);
      }

      const { data: userData } = await supabase
        .from('users')
        .select('id, rdn_user_id')
        .eq('id', operatorId)
        .single();

      const user = userData as Pick<User, 'id' | 'rdn_user_id'> | null;

      emitEvent('call.answered', {
        call_sid: parentCallSid,
        direction: 'inbound',
        status: 'in_progress',
        answered_by_user_id: operatorId,
        user_id: operatorId,
        rdn_user_id: user?.rdn_user_id ?? null,
      });
    } catch (err) {
      console.error('[AGENT-CONNECT] Error updating call record:', err);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();

  if (!conferenceName) {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Error: no se especificó sala de conferencia.'
    );
    twiml.hangup();
    return twimlResponse(twiml);
  }

  // Brief whisper to the agent
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Llamada entrante.'
  );

  // Join the conference where the caller is waiting
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const dial = twiml.dial({
    action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
  });
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      statusCallbackEvent: ['join', 'leave', 'end'],
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
    },
    conferenceName,
  );

  return twimlResponse(twiml);
}

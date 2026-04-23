import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { User } from '@/lib/types/database';
import { getTwilioClient } from '@/lib/twilio/client';

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
      let ringTargetIds: string[] = [];
      let parentTwilioData: Record<string, unknown> = {};
      if (agentCallSid) {
        const { data: existing } = await supabase
          .from('call_records')
          .select('twilio_data')
          .eq('twilio_call_sid', parentCallSid)
          .single();
        parentTwilioData = (
          existing?.twilio_data
          && typeof existing.twilio_data === 'object'
          && !Array.isArray(existing.twilio_data)
        ) ? (existing.twilio_data as Record<string, unknown>) : {};

        ringTargetIds = Array.isArray(parentTwilioData.current_ring_target_user_ids)
          ? (parentTwilioData.current_ring_target_user_ids as string[]).filter((id): id is string => typeof id === 'string')
          : [];

        const merged = {
          ...parentTwilioData,
          agent_call_sid: agentCallSid,
          current_ring_target_user_ids: [],
          ring_answered_by_user_id: operatorId,
          ring_answered_at: new Date().toISOString(),
        };
        await supabase
          .from('call_records')
          .update({ twilio_data: merged })
          .eq('twilio_call_sid', parentCallSid);
        console.log(`[AGENT-CONNECT] Stored agent_call_sid=${agentCallSid} in call_record ${parentCallSid}`);
      } else {
        const { data: existing } = await supabase
          .from('call_records')
          .select('twilio_data')
          .eq('twilio_call_sid', parentCallSid)
          .maybeSingle();
        parentTwilioData = (
          existing?.twilio_data
          && typeof existing.twilio_data === 'object'
          && !Array.isArray(existing.twilio_data)
        ) ? (existing.twilio_data as Record<string, unknown>) : {};
        ringTargetIds = Array.isArray(parentTwilioData.current_ring_target_user_ids)
          ? (parentTwilioData.current_ring_target_user_ids as string[]).filter((id): id is string => typeof id === 'string')
          : [];

        if (ringTargetIds.length > 0) {
          const merged = {
            ...parentTwilioData,
            current_ring_target_user_ids: [],
            ring_answered_by_user_id: operatorId,
            ring_answered_at: new Date().toISOString(),
          };
          await supabase
            .from('call_records')
            .update({ twilio_data: merged })
            .eq('twilio_call_sid', parentCallSid);
        }
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
        candidate_user_ids: ringTargetIds,
      });

      // --- ring_all cleanup: cancel other ringing agent legs ---
      try {
        const otherTargets = ringTargetIds.filter(id => id !== operatorId);

        if (otherTargets.length > 0) {
          const twilioClient = getTwilioClient();
          const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);

          for (const otherId of otherTargets) {
            // Cancel browser Device legs
            twilioClient.calls.list({
              to: `client:${otherId}`,
              status: 'ringing',
              startTimeAfter: recentCutoff,
            }).then(calls => {
              for (const c of calls) {
                twilioClient.calls(c.sid).update({ status: 'canceled' })
                  .then(() => console.log(`[AGENT-CONNECT] Canceled ring leg ${c.sid} → client:${otherId}`))
                  .catch(() => {});
              }
            }).catch(() => {});

            // Cancel phone legs too
            twilioClient.calls.list({
              to: `client:${otherId}`,
              status: 'queued',
              startTimeAfter: recentCutoff,
            }).then(calls => {
              for (const c of calls) {
                twilioClient.calls(c.sid).update({ status: 'canceled' }).catch(() => {});
              }
            }).catch(() => {});
          }
          console.log(`[AGENT-CONNECT] ring_all cleanup: canceling legs for ${otherTargets.length} other target(s)`);
        }
      } catch (cleanupErr) {
        console.warn('[AGENT-CONNECT] ring_all cleanup error (non-fatal):', cleanupErr);
      }
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

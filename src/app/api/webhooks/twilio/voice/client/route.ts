import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createCallRecord, updateCallStatus } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { User, PhoneNumber } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/client
 * TwiML App webhook executed when a browser Twilio Device starts a call.
 *
 * Also used by RDN-adopted calls created server-side to client:<agent-id>
 * with query params (outbound_to, caller_id, user_id).
 */
export async function POST(req: NextRequest) {
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const { searchParams } = new URL(req.url);
  const forcedOutboundTo = searchParams.get('outbound_to') || '';
  const forcedCallerId = searchParams.get('caller_id') || '';
  const forcedUserId = searchParams.get('user_id') || '';
  const source = searchParams.get('source') || '';

  const rawTo = params.To || '';
  const to = forcedOutboundTo || rawTo;
  const customCallerId = params.CallerId || forcedCallerId || '';
  const twilioFrom = params.From || '';
  const callSid = params.CallSid || '';
  let userId = params.UserId || forcedUserId || '';

  if (!userId && rawTo.startsWith('client:')) {
    userId = rawTo.replace('client:', '');
  }

  const isRdnAdopted = source === 'rdn' || Boolean(forcedOutboundTo);

  console.log(
    `[CLIENT-VOICE] mode=${isRdnAdopted ? 'rdn-adopted' : 'browser'} CallSid=${callSid} RawTo=${rawTo} To=${to} CallerId=${customCallerId} TwilioFrom=${twilioFrom} UserId=${userId}`
  );

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const supabase = createAdminClient();

    // Reconcile pending-* records: when Tauri does device.connect() with a
    // CallRecordId from a prior dial/route.ts SSE event, update the original
    // record's twilio_call_sid to the real Twilio CallSid.
    const callRecordId = params.CallRecordId || searchParams.get('call_record_id') || '';
    if (callRecordId && callSid) {
      const { data: pendingRecord } = await supabase
        .from('call_records')
        .select('id, twilio_call_sid')
        .eq('id', callRecordId)
        .maybeSingle();

      if (pendingRecord && typeof pendingRecord.twilio_call_sid === 'string' && pendingRecord.twilio_call_sid.startsWith('pending-')) {
        console.log(
          `[CLIENT-VOICE] Reconciling pending record id=${callRecordId} old_sid=${pendingRecord.twilio_call_sid} new_sid=${callSid}`
        );
        await supabase
          .from('call_records')
          .update({ twilio_call_sid: callSid, status: 'ringing' })
          .eq('id', callRecordId);
      }
    }

    const ensureRecord = async (input: {
      direction: 'outbound' | 'inbound';
      fromNumber: string;
      toNumber: string;
      status: string;
      phoneNumberId?: string | null;
      twilioData?: Record<string, unknown>;
    }) => {
      if (!callSid) return null;

      // If we already reconciled a pending record, reuse it
      if (callRecordId) {
        const { data: reconciled } = await supabase
          .from('call_records')
          .select('id')
          .eq('id', callRecordId)
          .eq('twilio_call_sid', callSid)
          .maybeSingle();

        if (reconciled?.id) {
          console.log(`[CLIENT-VOICE] Using reconciled record id=${reconciled.id} for CallSid=${callSid}`);
          return reconciled.id as string;
        }
      }

      const { data: existing } = await supabase
        .from('call_records')
        .select('id')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();

      if (existing?.id) {
        console.log(`[CLIENT-VOICE] Reusing existing call_record id=${existing.id} for CallSid=${callSid}`);
        return existing.id as string;
      }

      return createCallRecord({
        twilioCallSid: callSid,
        ...input,
      });
    };

    if (to && to.startsWith('conference:')) {
      // Agent joining a conference via device.connect() from Tauri desktop app.
      // Format: conference:<conference-name>
      const conferenceRoom = to.replace('conference:', '');
      const parentCallSid = params.ParentCallSid || searchParams.get('parent_call_sid') || '';
      const operatorId = userId || '';

      console.log(
        `[CLIENT-VOICE] Conference join: room=${conferenceRoom} parentCallSid=${parentCallSid} operatorId=${operatorId}`
      );

      // Update call record if we have the parent call SID
      if (parentCallSid && operatorId) {
        try {
          await updateCallStatus(parentCallSid, {
            status: 'in_progress',
            answeredAt: new Date().toISOString(),
            answeredByUserId: operatorId,
          });

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
          console.error('[CLIENT-VOICE] Error updating call record for conference join:', err);
        }
      }

      const dial = twiml.dial({
        action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      });
      dial.conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: false,
        },
        conferenceRoom,
      );
    } else if (to && to.startsWith('client:')) {
      // Browser-to-browser internal call.
      const targetIdentity = to.replace('client:', '');

      let initiatorName = 'Sistema';
      if (userId) {
        const { data: user } = await supabase
          .from('users')
          .select('name')
          .eq('id', userId)
          .single();
        if (user) initiatorName = (user as User).name;
      }

      let callerId = customCallerId;
      if (!callerId || callerId.startsWith('client:')) {
        const { data: firstNum } = await supabase
          .from('phone_numbers')
          .select('phone_number')
          .eq('active', true)
          .limit(1)
          .single();
        callerId = (firstNum as PhoneNumber)?.phone_number || '';
      }

      await ensureRecord({
        direction: 'outbound',
        fromNumber: callerId || `client:${userId}`,
        toNumber: to,
        status: 'ringing',
        twilioData: {
          initiated_by: userId || 'unknown',
          initiator_name: initiatorName,
          source: isRdnAdopted ? 'rdn_adopted_browser' : 'browser',
          internal: true,
        },
      });

      if (userId) {
        await updateCallStatus(callSid, { answeredByUserId: userId });
      }

      const dial = twiml.dial({
        callerId,
        timeout: 30,
        action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      });

      dial.client(
        {
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        },
        targetIdentity,
      );
    } else if (to && !to.startsWith('client:')) {
      // Call to external phone number.
      let callerId = customCallerId;
      if (!callerId || callerId.startsWith('client:')) {
        const { data: firstNum } = await supabase
          .from('phone_numbers')
          .select('phone_number')
          .eq('active', true)
          .limit(1)
          .single();
        callerId = (firstNum as PhoneNumber)?.phone_number || '';
      }

      let initiatorName = 'Sistema';
      if (userId) {
        const { data: user } = await supabase
          .from('users')
          .select('name')
          .eq('id', userId)
          .single();
        if (user) initiatorName = (user as User).name;
      }

      const phoneData = await supabase
        .from('phone_numbers')
        .select('id, record_calls')
        .eq('phone_number', callerId)
        .single();

      const phoneNumberId = phoneData.data?.id || null;
      const shouldRecord = phoneData.data?.record_calls ?? false;

      await ensureRecord({
        direction: 'outbound',
        fromNumber: callerId,
        toNumber: to,
        status: 'ringing',
        phoneNumberId,
        twilioData: {
          initiated_by: userId || 'unknown',
          initiator_name: initiatorName,
          source: isRdnAdopted ? 'rdn_adopted' : 'browser',
        },
      });

      if (userId) {
        await updateCallStatus(callSid, { answeredByUserId: userId });
      }

      const dial = twiml.dial({
        callerId,
        timeout: 30,
        record: shouldRecord ? ('record-from-answer-dual' as const) : ('do-not-record' as const),
        recordingStatusCallback: shouldRecord
          ? `${baseUrl}/api/webhooks/twilio/recording/status`
          : undefined,
        action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      });

      dial.number(
        {
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        },
        to,
      );
    } else {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No se ha especificado un numero de destino.'
      );
      twiml.hangup();
    }
  } catch (err) {
    console.error('[CLIENT-VOICE] Error:', err);
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Error al procesar la llamada.'
    );
    twiml.hangup();
  }

  return twimlResponse(twiml);
}

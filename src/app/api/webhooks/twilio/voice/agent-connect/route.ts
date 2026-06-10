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

  // ── Guards de idempotencia ──────────────────────────────────────────────
  // Este webhook se ejecuta para CUALQUIER leg de ring que conteste: el
  // Device del agente, su teléfono físico... o el BUZÓN DE VOZ de su móvil.
  // Sin estos guards, una segunda leg contestando se metía en la conferencia
  // con endConferenceOnExit:true y al colgar (el buzón cuelga solo a los
  // 1-3 min) tiraba la sala entera con la conversación en curso. También
  // evita unirse a la conferencia de una llamada que ya terminó (leg que
  // contesta un ring cancelado una décima tarde).
  if (parentCallSid) {
    try {
      const supabaseGuard = createAdminClient();
      const { data: guardRecord } = await supabaseGuard
        .from('call_records')
        .select('status, ended_at, answered_by_user_id, twilio_data')
        .eq('twilio_call_sid', parentCallSid)
        .maybeSingle();

      if (guardRecord) {
        const terminalStatuses = ['completed', 'busy', 'no_answer', 'failed', 'canceled'];
        const recordIsTerminal = terminalStatuses.includes(String(guardRecord.status))
          || Boolean(guardRecord.ended_at);

        if (recordIsTerminal) {
          console.warn(
            `[AGENT-CONNECT][GUARD] Leg ${agentCallSid || '-'} (operator=${operatorId || '-'}) contestó una llamada ya terminal (status=${guardRecord.status}). No se une a la conferencia.`
          );
          const guardTwiml = new twilio.twiml.VoiceResponse();
          guardTwiml.say(
            { language: 'es-ES', voice: 'Polly.Conchita' },
            'La llamada ya ha finalizado.'
          );
          guardTwiml.hangup();
          return twimlResponse(guardTwiml);
        }

        const guardData = (
          guardRecord.twilio_data
          && typeof guardRecord.twilio_data === 'object'
          && !Array.isArray(guardRecord.twilio_data)
        ) ? (guardRecord.twilio_data as Record<string, unknown>) : {};
        const existingAgentLeg = typeof guardData.agent_call_sid === 'string'
          ? guardData.agent_call_sid
          : null;

        if (existingAgentLeg && agentCallSid && existingAgentLeg !== agentCallSid) {
          // Ya hay una leg de agente registrada para esta llamada. Solo
          // rechazamos esta segunda leg si la primera sigue VIVA — si murió
          // (blip de red, leg colgada), dejar pasar permite re-contestar.
          try {
            const liveLeg = await getTwilioClient().calls(existingAgentLeg).fetch();
            const liveLegStatus = (liveLeg.status || '').toLowerCase();
            if (liveLegStatus === 'in-progress') {
              console.warn(
                `[AGENT-CONNECT][GUARD] Leg duplicada ${agentCallSid} (operator=${operatorId || '-'}) — la llamada ya está atendida por la leg ${existingAgentLeg} (viva). Probable buzón de voz o segunda contestación.`
              );
              const guardTwiml = new twilio.twiml.VoiceResponse();
              guardTwiml.say(
                { language: 'es-ES', voice: 'Polly.Conchita' },
                'Esta llamada ya está siendo atendida.'
              );
              guardTwiml.hangup();
              return twimlResponse(guardTwiml);
            }
          } catch {
            // Leg anterior desaparecida o API inaccesible: preferimos conectar
            // al agente antes que bloquear una contestación legítima.
          }
        }
      }
    } catch (guardErr) {
      console.warn('[AGENT-CONNECT] Guard de idempotencia falló (continuando):', guardErr);
    }
  }

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

      // --- Ring cleanup: cancelar todas las legs de ring que sigan vivas ---
      // Cubre dos casos que antes quedaban sonando:
      //  a) Las legs de TELÉFONO FÍSICO. El código anterior decía "Cancel
      //     phone legs too" pero ambas consultas buscaban `client:<id>`, así
      //     que los móviles/fijos nunca se cancelaban.
      //  b) Las legs HERMANAS del agente que contestó: si contestaba en
      //     Tauri, su móvil seguía sonando hasta el timeout — y si saltaba el
      //     buzón de voz, este entraba a la conferencia (guard de arriba lo
      //     corta ahora) o, peor, contestaba un humano y se pisaban.
      // Nunca se cancela `agentCallSid` (la leg que acaba de contestar).
      try {
        const cleanupTargetIds = [...new Set([...ringTargetIds, operatorId])]
          .filter((id): id is string => typeof id === 'string' && id.length > 0);

        if (cleanupTargetIds.length > 0) {
          const twilioClient = getTwilioClient();
          const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);

          const { data: targetUsers } = await supabase
            .from('users')
            .select('id, phone')
            .in('id', cleanupTargetIds);

          const phoneByUserId = new Map<string, string>();
          for (const row of (targetUsers ?? []) as Array<{ id: string; phone: string | null }>) {
            if (row.phone && row.phone.trim().length > 0) {
              phoneByUserId.set(row.id, row.phone.trim());
            }
          }

          const cancelRingLegsTo = (to: string) => {
            for (const legStatus of ['ringing', 'queued'] as const) {
              twilioClient.calls.list({
                to,
                status: legStatus,
                startTimeAfter: recentCutoff,
              }).then(calls => {
                for (const c of calls) {
                  if (c.sid === agentCallSid) continue;
                  twilioClient.calls(c.sid).update({ status: 'canceled' })
                    .then(() => console.log(`[AGENT-CONNECT] Canceled ring leg ${c.sid} → ${to} (${legStatus})`))
                    .catch(() => {});
                }
              }).catch(() => {});
            }
          };

          for (const targetId of cleanupTargetIds) {
            cancelRingLegsTo(`client:${targetId}`);
            const phone = phoneByUserId.get(targetId);
            if (phone) cancelRingLegsTo(phone);
          }
          console.log(
            `[AGENT-CONNECT] ring cleanup: client+phone legs de ${cleanupTargetIds.length} target(s), conservando ${agentCallSid || '-'}`
          );
        }
      } catch (cleanupErr) {
        console.warn('[AGENT-CONNECT] ring cleanup error (non-fatal):', cleanupErr);
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
      // F1.4: la leg del agente ya NO arrastra la sala al caerse. Antes,
      // cualquier blip de su red/softphone terminaba la conferencia y
      // dial-action colgaba al llamante. Ahora la sala sobrevive; el
      // teardown legítimo lo hacen /hangup (cuelga ambas legs) y el
      // room-watchdog (re-encola o cierra si el agente no vuelve).
      endConferenceOnExit: false,
      statusCallbackEvent: ['join', 'leave', 'end'],
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
    },
    conferenceName,
  );

  return twimlResponse(twiml);
}

import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { User } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/whisper
 * Se ejecuta cuando el operador descuelga, ANTES de conectarle con el caller.
 * Sirve para:
 * 1. Anunciar al operador de qué va la llamada
 * 2. Registrar quién contestó en la DB
 *
 * Query params: operator_id, call_sid
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;
  const { searchParams } = new URL(req.url);

  const operatorId = searchParams.get('operator_id') || '';
  const parentCallSid = searchParams.get('call_sid') || '';
  const from = params.From || 'desconocido';

  console.log(`[WHISPER] Operator=${operatorId} CallSid=${parentCallSid} From=${from}`);

  // Registrar quién contestó
  if (parentCallSid && operatorId) {
    try {
      await updateCallStatus(parentCallSid, {
        status: 'in_progress',
        answeredAt: new Date().toISOString(),
        answeredByUserId: operatorId,
      });

      const supabase = createAdminClient();
      const { data: userData } = await supabase
        .from('users')
        .select('id, rdn_user_id')
        .eq('id', operatorId)
        .single();

      const user = userData as Pick<User, 'id' | 'rdn_user_id'> | null;

      console.log(
        `[WHISPER] inbound answered call_sid=${parentCallSid} operator_id=${operatorId} rdn_user_id=${user?.rdn_user_id ?? 'null'}`
      );

      emitEvent('call.answered', {
        call_sid: parentCallSid,
        direction: 'inbound',
        status: 'in_progress',
        answered_by_user_id: operatorId,
        user_id: operatorId,
        rdn_user_id: user?.rdn_user_id ?? null,
        from: params.From || null,
        to: params.To || null,
      });
    } catch (err) {
      console.error('[WHISPER] Error updating call record:', err);
    }
  }

  // TwiML: breve anuncio al operador
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    `Llamada entrante.`
  );

  return twimlResponse(twiml);
}

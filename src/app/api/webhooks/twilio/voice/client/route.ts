import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createCallRecord } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import type { User, PhoneNumber } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/client
 * Webhook para la TwiML App de Twilio.
 * Se ejecuta cuando un cliente del navegador (Twilio Device) inicia una llamada saliente.
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const to = params.To || '';
  // Leer CallerId (param personalizado) — NO usar From que Twilio sobreescribe con "client:<identity>"
  const customCallerId = params.CallerId || '';
  const twilioFrom = params.From || '';
  const userId = params.UserId || '';
  const callSid = params.CallSid || '';

  console.log(`[CLIENT-VOICE] CallSid=${callSid} To=${to} CallerId=${customCallerId} TwilioFrom=${twilioFrom} UserId=${userId}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    if (to && to.startsWith('client:')) {
      // ─── Llamada entre clientes del navegador (ej: consulta a otro operador) ───
      const targetIdentity = to.replace('client:', '');
      const supabase = createAdminClient();

      // Obtener nombre del usuario iniciador
      let initiatorName = 'Sistema';
      if (userId) {
        const { data: user } = await supabase
          .from('users')
          .select('name')
          .eq('id', userId)
          .single();
        if (user) initiatorName = (user as User).name;
      }

      // Resolver callerId para el registro
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

      // Registrar la llamada interna en DB
      await createCallRecord({
        twilioCallSid: callSid,
        direction: 'outbound',
        fromNumber: callerId || `client:${userId}`,
        toNumber: to,
        status: 'ringing',
        twilioData: {
          initiated_by: userId || 'unknown',
          initiator_name: initiatorName,
          source: 'browser',
          internal: 'true',
        },
      });

      // Dial al cliente del navegador destino
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
        targetIdentity
      );

    } else if (to && !to.startsWith('client:')) {
      // ─── Llamada a número de teléfono externo ───
      const supabase = createAdminClient();

      // Resolver callerId: usar el param personalizado, o buscar uno válido
      // NUNCA usar "client:xxx" como callerId (no es un número real)
      let callerId = customCallerId;
      if (!callerId || callerId.startsWith('client:')) {
        // Usar el primer número activo como fallback
        const { data: firstNum } = await supabase
          .from('phone_numbers')
          .select('phone_number')
          .eq('active', true)
          .limit(1)
          .single();
        callerId = (firstNum as PhoneNumber)?.phone_number || '';
      }

      // Obtener nombre del usuario
      let initiatorName = 'Sistema';
      if (userId) {
        const { data: user } = await supabase
          .from('users')
          .select('name')
          .eq('id', userId)
          .single();
        if (user) initiatorName = (user as User).name;
      }

      // Registrar la llamada en DB
      const phoneData = await supabase
        .from('phone_numbers')
        .select('id, record_calls')
        .eq('phone_number', callerId)
        .single();

      const phoneNumberId = phoneData.data?.id || null;
      const shouldRecord = phoneData.data?.record_calls ?? false;

      await createCallRecord({
        twilioCallSid: callSid,
        direction: 'outbound',
        fromNumber: callerId,
        toNumber: to,
        status: 'ringing',
        phoneNumberId,
        twilioData: {
          initiated_by: userId || 'unknown',
          initiator_name: initiatorName,
          source: 'browser',
        },
      });

      // Dial al número destino
      const dial = twiml.dial({
        callerId,
        timeout: 30,
        record: shouldRecord ? 'record-from-answer-dual' as const : 'do-not-record' as const,
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
        to
      );
    } else {
      // Sin destino válido
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No se ha especificado un número de destino.'
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

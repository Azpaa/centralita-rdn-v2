import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';

/**
 * POST /api/webhooks/twilio/voice/outbound-connect
 * TwiML que Twilio ejecuta cuando se inicia una llamada saliente.
 * Como llamamos directamente al destino, este TwiML simplemente
 * mantiene la llamada abierta y opcionalmente graba.
 *
 * Query params:
 * - caller_id: número de origen (para determinar si grabar)
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const callerId = searchParams.get('caller_id') || '';

  console.log(`[OUTBOUND-CONNECT] Call answered, caller_id=${callerId}`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Comprobar si este número tiene grabación activa
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
    // Ignorar error, no grabar
  }

  if (shouldRecord) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    twiml.record({
      recordingStatusCallback: `${baseUrl}/api/webhooks/twilio/recording/status`,
      recordingStatusCallbackEvent: ['completed'],
    });
  }

  // La llamada se mantiene abierta — el destino ya está conectado
  // No se necesita <Dial> adicional porque Twilio ya llamó al destino directamente
  return twimlResponse(twiml);
}

function twimlResponse(twiml: twilio.twiml.VoiceResponse): NextResponse {
  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';

/**
 * POST /api/webhooks/twilio/voice/transfer-connect
 * TwiML endpoint invocado cuando se redirige una llamada para transferencia en frío.
 * Conecta la llamada con el nuevo destino.
 *
 * Query params:
 * - destination: número de teléfono o "client:<userId>"
 * - caller_id: callerId para la llamada transferida
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const destination = searchParams.get('destination') || '';
  const callerId = searchParams.get('caller_id') || '';
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  console.log(`[TRANSFER-CONNECT] Transferring to ${destination} callerId=${callerId}`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!destination) {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Error en la transferencia. No se especificó destino.'
    );
    twiml.hangup();
    return twimlResponse(twiml);
  }

  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Transfiriendo su llamada. Un momento por favor.'
  );

  const dial = twiml.dial({
    callerId: callerId || undefined,
    timeout: 30,
    action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
  });

  if (destination.startsWith('client:')) {
    // Transferir a un usuario del navegador
    dial.client(
      {
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      },
      destination.replace('client:', '')
    );
  } else {
    // Transferir a un número de teléfono
    dial.number(
      {
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      },
      destination
    );
  }

  return twimlResponse(twiml);
}

function twimlResponse(twiml: twilio.twiml.VoiceResponse): NextResponse {
  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

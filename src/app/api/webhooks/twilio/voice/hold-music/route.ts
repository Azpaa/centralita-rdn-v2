import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';

/**
 * POST /api/webhooks/twilio/voice/hold-music
 * TwiML que reproduce música de espera en bucle.
 * Se usa cuando se pone una llamada en hold.
 *
 * Query params:
 * - unhold: si es "true", devuelve TwiML vacío para que la llamada siga
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const unhold = searchParams.get('unhold') === 'true';

  const twiml = new twilio.twiml.VoiceResponse();

  if (unhold) {
    // Al sacar de hold, simplemente decimos que estamos conectando
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Reconectando.'
    );
    // Pausar brevemente — el front-end debería manejar la reconexión
    twiml.pause({ length: 120 });
  } else {
    // Música de espera en bucle
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Le hemos puesto en espera. Por favor, no cuelgue.'
    );
    // Bucle de música de espera (Twilio default hold music)
    twiml.play({
      loop: 0, // loop infinito
    }, 'http://com.twilio.music.classical.s3.amazonaws.com/ith_chopin-702702.mp3');
  }

  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

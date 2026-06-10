import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { twimlResponse } from '@/lib/api/twilio-auth';

function resolveWaitAudioUrl(baseUrl: string): string {
  const fromEnv = process.env.TWILIO_QUEUE_WAIT_AUDIO_URL?.trim();
  if (fromEnv) return fromEnv;
  return `${baseUrl}/audio/hold-ringback-es.wav`;
}

// Tope absoluto del bucle de espera. Antes este endpoint se redirigía a sí
// mismo SIN límite: si la leg del agente moría sin un /resume (crash, pause
// caducada), el cliente quedaba escuchando música hasta el límite de 24h de
// Twilio — una llamada zombi facturando sin que ningún registro la vigilara
// (la leg hija no tiene call_record propio).
const MAX_HOLD_WAIT_MS = 30 * 60 * 1000;

function buildSilenceResponse(req: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const { searchParams } = new URL(req.url);

  const startedRaw = searchParams.get('_t');
  const startedMs = startedRaw ? parseInt(startedRaw, 10) : NaN;
  const startedAt = Number.isFinite(startedMs) ? startedMs : Date.now();

  const twiml = new twilio.twiml.VoiceResponse();

  if (Date.now() - startedAt >= MAX_HOLD_WAIT_MS) {
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Lo sentimos, la espera ha superado el tiempo máximo. Por favor, llame de nuevo. Gracias.'
    );
    twiml.hangup();
    return twimlResponse(twiml);
  }

  twiml.play(resolveWaitAudioUrl(baseUrl));
  twiml.redirect(
    { method: 'POST' },
    `${baseUrl}/api/webhooks/twilio/voice/wait-silence?_t=${startedAt}`
  );
  return twimlResponse(twiml);
}

export async function GET(req: NextRequest) {
  return buildSilenceResponse(req);
}

export async function POST(req: NextRequest) {
  return buildSilenceResponse(req);
}

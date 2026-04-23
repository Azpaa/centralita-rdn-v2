import twilio from 'twilio';
import { twimlResponse } from '@/lib/api/twilio-auth';

function resolveWaitAudioUrl(baseUrl: string): string {
  const fromEnv = process.env.TWILIO_QUEUE_WAIT_AUDIO_URL?.trim();
  if (fromEnv) return fromEnv;
  return `${baseUrl}/audio/hold-ringback-es.wav`;
}

function buildSilenceResponse(baseUrl: string) {
  const twiml = new twilio.twiml.VoiceResponse();
  // Fallback hold loop for routes that still point to this endpoint.
  twiml.play(resolveWaitAudioUrl(baseUrl));
  twiml.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/wait-silence`);
  return twimlResponse(twiml);
}

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return buildSilenceResponse(baseUrl);
}

export async function POST() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return buildSilenceResponse(baseUrl);
}

import twilio from 'twilio';
import { twimlResponse } from '@/lib/api/twilio-auth';

function buildSilenceResponse(baseUrl: string) {
  const twiml = new twilio.twiml.VoiceResponse();
  // Keep caller on hold with a basic and familiar hold audio.
  // Avoid digit tones/beeps that feel abrupt for callers.
  twiml.play('https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3');
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

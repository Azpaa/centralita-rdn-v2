import twilio from 'twilio';
import { twimlResponse } from '@/lib/api/twilio-auth';

function buildSilenceResponse(baseUrl: string) {
  const twiml = new twilio.twiml.VoiceResponse();
  // Keep caller on hold without background music.
  twiml.pause({ length: 60 });
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

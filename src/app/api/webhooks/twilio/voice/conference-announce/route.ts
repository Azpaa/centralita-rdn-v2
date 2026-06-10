import twilio from 'twilio';
import { twimlResponse } from '@/lib/api/twilio-auth';

/**
 * GET/POST /api/webhooks/twilio/voice/conference-announce
 *
 * TwiML estático que el room-watchdog reproduce en la sala (announceUrl)
 * cuando la leg del agente se cae con la llamada en curso: tranquiliza al
 * llamante durante la ventana de gracia mientras el softphone intenta el
 * rejoin automático.
 */
function buildAnnounceResponse() {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { language: 'es-ES', voice: 'Polly.Conchita' },
    'Un momento, por favor. Estamos restableciendo la conexión con su agente.'
  );
  return twimlResponse(twiml);
}

export async function GET() {
  return buildAnnounceResponse();
}

export async function POST() {
  return buildAnnounceResponse();
}

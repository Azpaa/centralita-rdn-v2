import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';

/**
 * POST /api/v1/calls/:id/hold
 * Pone una llamada en espera.
 *
 * Implementación: redirige la leg remota a un TwiML de música de espera.
 * Cuando se quiera sacar de espera, se usa /resume.
 *
 * Body (opcional): { music_url?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  let body: { music_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío es OK
  }

  try {
    const client = getTwilioClient();

    const callInfo = await client.calls(callSid).fetch();
    let remoteSid: string;

    if (callInfo.parentCallSid) {
      remoteSid = callInfo.parentCallSid;
    } else {
      const children = await client.calls.list({
        parentCallSid: callSid,
        status: 'in-progress',
        limit: 1,
      });
      if (children.length === 0) {
        return apiBadRequest('No se encontró la otra parte de la llamada');
      }
      remoteSid = children[0].sid;
    }

    const holdTwiml = new twilio.twiml.VoiceResponse();
    holdTwiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Un momento por favor, le ponemos en espera.'
    );
    holdTwiml.play({
      loop: 0,
    }, body.music_url || 'http://com.twilio.music.classical.s3.amazonaws.com/ith_chopin-702702.mp3');

    await client.calls(remoteSid).update({ twiml: holdTwiml.toString() });

    emitEvent('call.hold', {
      call_sid: callSid,
      remote_call_sid: remoteSid,
      by_user_id: auth.userId ?? 'api_key',
    });

    return apiSuccess({ held: true, callSid, remoteSid });
  } catch (err) {
    console.error(`[HOLD] Error holding ${callSid}:`, err);
    return apiInternalError('Error al poner en espera');
  }
}

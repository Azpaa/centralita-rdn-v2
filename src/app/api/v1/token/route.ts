import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import type { User } from '@/lib/types/database';

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

/**
 * GET /api/v1/token
 * Genera un Access Token de Twilio para el Twilio Voice SDK del navegador.
 * El identity del token es el userId del usuario autenticado.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const apiKeySid = process.env.TWILIO_API_KEY_SID!;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET!;
    const twimlAppSid = process.env.TWILIO_TWIML_APP_SID!;

    if (!apiKeySid || !apiKeySecret) {
      console.error('[TOKEN] TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET no configurados');
      return apiInternalError('Twilio API Key no configurado');
    }

    if (!twimlAppSid) {
      console.error('[TOKEN] TWILIO_TWIML_APP_SID no configurado');
      return apiInternalError('Twilio TwiML App no configurado');
    }

    // Obtener datos del usuario para la identidad
    let identity = auth.userId || 'anonymous';
    let userName = 'Usuario';

    if (auth.userId) {
      const supabase = createAdminClient();
      const { data: user } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('id', auth.userId)
        .single();

      if (user) {
        const u = user as User;
        identity = u.id;
        userName = u.name;
      }
    }

    // Crear Access Token — TTL largo para que el dispositivo se mantenga
    // registrado incluso con la pestaña en segundo plano.
    // El SDK de Twilio dispara 'tokenWillExpire' ~10 min antes de expirar
    // para que el front-end pueda refrescar sin interrupciones.
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 28800, // 8 horas
    });

    // Conceder permisos de voz (entrantes y salientes)
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    return apiSuccess({
      token: token.toJwt(),
      identity,
      userName,
    });
  } catch (err) {
    console.error('[TOKEN] Error generating token:', err);
    return apiInternalError('Error generando token de voz');
  }
}

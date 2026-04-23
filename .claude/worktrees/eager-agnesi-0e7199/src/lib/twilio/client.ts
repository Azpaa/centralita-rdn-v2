import twilio from 'twilio';

/**
 * Cliente de Twilio para operaciones de servidor.
 * Singleton lazy — se crea una vez al primer uso.
 */
let _client: twilio.Twilio | null = null;

export function getTwilioClient(): twilio.Twilio {
  if (!_client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN son requeridos');
    }

    _client = twilio(accountSid, authToken);
  }

  return _client;
}

/**
 * Helper para generar TwiML Response.
 */
export function twimlResponse(twiml: twilio.twiml.VoiceResponse): Response {
  return new Response(twiml.toString(), {
    headers: {
      'Content-Type': 'text/xml',
    },
  });
}

export { twilio };

import twilio from 'twilio';

/**
 * Cliente de Twilio para operaciones de servidor.
 * Singleton lazy — se crea una vez al primer uso.
 */
let _client: twilio.Twilio | null = null;

// Por defecto el SDK de Twilio usa un timeout de request de 30s. Eso es MÁS
// largo que el timeout del webhook de voz de Twilio (~15s): una sola REST
// lenta/colgada (429, blip de red, incidente de Twilio) bloquea el handler
// del webhook hasta que Twilio ya ha desistido → 502 → la llamada se cae.
// Acotamos el request a 10s para que una REST atascada falle DENTRO de la
// ventana del webhook; el try/catch de cada webhook devuelve entonces TwiML
// seguro en vez de un 500. keepAlive reutiliza la conexión TLS (menos
// latencia por llamada). autoRetry solo cubre 429 (rate limit) con backoff.
const TWILIO_REQUEST_TIMEOUT_MS = 10_000;
const TWILIO_MAX_RETRIES = 2;

export function getTwilioClient(): twilio.Twilio {
  if (!_client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN son requeridos');
    }

    _client = twilio(accountSid, authToken, {
      httpClient: new twilio.RequestClient({
        timeout: TWILIO_REQUEST_TIMEOUT_MS,
        keepAlive: true,
        autoRetry: true,
        maxRetries: TWILIO_MAX_RETRIES,
      }),
    });
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

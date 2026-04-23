import { NextRequest, NextResponse } from 'next/server';
import { apiUnauthorized } from '@/lib/api/response';
import twilio from 'twilio';

/**
 * Resultado de procesar un webhook de Twilio.
 * Si la validación falla devuelve una Response de error.
 * Si tiene éxito devuelve el body parseado.
 */
export type TwilioWebhookResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Valida y parsea un webhook de Twilio en un solo paso.
 *
 * 1. Lee el body una sola vez.
 * 2. Comprueba X-Twilio-Signature contra TWILIO_AUTH_TOKEN.
 * 3. Devuelve los parámetros parseados si la firma es válida.
 *
 * En desarrollo (NODE_ENV !== 'production') se omite la validación
 * de firma para facilitar el testing local con ngrok/localTunnel.
 */
export async function validateAndParseTwilioWebhook(
  req: NextRequest,
): Promise<TwilioWebhookResult> {
  const body = await req.text();
  const params = parseTwilioBody(body);

  // En producción, validar la firma de Twilio
  if (process.env.NODE_ENV === 'production') {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.error('[TWILIO-AUTH] TWILIO_AUTH_TOKEN no configurado');
      return { ok: false, response: apiUnauthorized('Configuración de Twilio incompleta') };
    }

    const signature = req.headers.get('x-twilio-signature') || '';

    // Twilio firma contra la URL pública. Detrás de Cloudflare Tunnel / reverse proxy,
    // req.url puede ser http://localhost:3000/... en lugar de la URL pública.
    // Reconstruimos la URL usando NEXT_PUBLIC_APP_URL para que coincida.
    const publicBase = process.env.NEXT_PUBLIC_APP_URL || '';
    let validationUrl = req.url;
    if (publicBase) {
      const urlObj = new URL(req.url);
      validationUrl = `${publicBase}${urlObj.pathname}${urlObj.search}`;
    }

    const isValid = twilio.validateRequest(authToken, signature, validationUrl, params);

    if (!isValid) {
      console.warn('[TWILIO-AUTH] Firma inválida', { url: req.url });
      return { ok: false, response: apiUnauthorized('Firma de Twilio inválida') };
    }
  }

  return { ok: true, params };
}

/**
 * Wrapper ligero para webhooks que solo devuelven TwiML estático
 * y no leen el body (hold-music, conference-join, etc.).
 * Valida la firma sin consumir params.
 */
export async function validateTwilioWebhookLight(
  req: NextRequest,
): Promise<true | Response> {
  if (process.env.NODE_ENV !== 'production') return true;

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[TWILIO-AUTH] TWILIO_AUTH_TOKEN no configurado');
    return apiUnauthorized('Configuración de Twilio incompleta');
  }

  const signature = req.headers.get('x-twilio-signature') || '';
  const body = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((value, key) => {
    params[key] = value;
  });

  // Reconstruir URL pública (misma lógica que validateAndParseTwilioWebhook)
  const publicBase = process.env.NEXT_PUBLIC_APP_URL || '';
  let validationUrl = req.url;
  if (publicBase) {
    const urlObj = new URL(req.url);
    validationUrl = `${publicBase}${urlObj.pathname}${urlObj.search}`;
  }

  const isValid = twilio.validateRequest(authToken, signature, validationUrl, params);
  if (!isValid) {
    console.warn('[TWILIO-AUTH] Firma inválida (light)', { url: validationUrl });
    return apiUnauthorized('Firma de Twilio inválida');
  }
  return true;
}

/**
 * Parsea el body de un webhook de Twilio (URL-encoded) a un objeto.
 */
export function parseTwilioBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

/**
 * Respuesta TwiML helper.
 */
export function twimlResponse(twiml: { toString(): string }): NextResponse {
  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}

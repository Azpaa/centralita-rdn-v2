import { NextRequest } from 'next/server';
import { apiUnauthorized } from '@/lib/api/response';
import twilio from 'twilio';

/**
 * Valida que un webhook viene realmente de Twilio.
 * Comprueba la firma X-Twilio-Signature contra el auth token.
 */
export async function validateTwilioWebhook(req: NextRequest): Promise<boolean | Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('TWILIO_AUTH_TOKEN no configurado');
    return apiUnauthorized('Configuración de Twilio incompleta');
  }

  const signature = req.headers.get('x-twilio-signature') || '';
  const url = req.url;

  // Obtener el body como form data (Twilio envía application/x-www-form-urlencoded)
  const body = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((value, key) => {
    params[key] = value;
  });

  const isValid = twilio.validateRequest(authToken, signature, url, params);

  if (!isValid) {
    console.warn('Webhook de Twilio con firma inválida', { url });
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

import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { dialSchema } from '@/lib/api/validation';
import { getTwilioClient } from '@/lib/twilio/client';
import { createCallRecord } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';
import type { PhoneNumber, User } from '@/lib/types/database';

/**
 * POST /api/v1/calls/dial
 * Inicia una llamada saliente desde el panel.
 *
 * Flujo directo:
 * 1. El panel envía: destination_number + from_number (número Twilio activo)
 * 2. Twilio llama directamente al destino desde el número seleccionado
 * 3. El usuario que inicia la llamada se registra automáticamente vía sesión
 *
 * Body: { destination_number, from_number }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = dialSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const { destination_number, from_number } = parsed.data;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const supabase = createAdminClient();

    // Verificar que from_number es un número activo en nuestra cuenta
    const { data: phoneNum } = await supabase
      .from('phone_numbers')
      .select('*')
      .eq('phone_number', from_number)
      .eq('active', true)
      .single();

    if (!phoneNum) {
      return apiBadRequest('El número de origen no es un número Twilio activo.');
    }

    const activeNumber = phoneNum as PhoneNumber;

    // Obtener nombre del usuario que inicia la llamada (para audit)
    let initiatorName = 'Sistema';
    if (auth.userId) {
      const { data: user } = await supabase
        .from('users')
        .select('name')
        .eq('id', auth.userId)
        .single();
      if (user) initiatorName = (user as User).name;
    }

    // Llamar directamente al destino
    const twilioClient = getTwilioClient();

    const call = await twilioClient.calls.create({
      to: destination_number,
      from: from_number,
      // TwiML sencillo: cuando el destino contesta, se queda la llamada abierta
      // con grabación si está configurado en el número
      url: `${baseUrl}/api/webhooks/twilio/voice/outbound-connect?caller_id=${encodeURIComponent(from_number)}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    // Registrar en DB
    const callRecordId = await createCallRecord({
      twilioCallSid: call.sid,
      direction: 'outbound',
      fromNumber: from_number,
      toNumber: destination_number,
      status: 'ringing',
      phoneNumberId: activeNumber.id,
      twilioData: {
        initiated_by: auth.userId || 'unknown',
        initiator_name: initiatorName,
      },
    });

    await auditLog('call.dial', 'call_record', callRecordId, auth.userId, {
      destination: destination_number,
      from: from_number,
      initiator: initiatorName,
    });

    return apiSuccess({
      call_sid: call.sid,
      call_record_id: callRecordId,
      status: 'initiated',
      from: from_number,
      to: destination_number,
    });
  } catch (err) {
    console.error('[DIAL] Error creating outbound call:', err);
    return apiInternalError('Error al iniciar la llamada');
  }
}

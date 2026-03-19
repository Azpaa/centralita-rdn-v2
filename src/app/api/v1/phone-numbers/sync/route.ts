import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { auditLog } from '@/lib/api/audit';

// POST /api/v1/phone-numbers/sync — Sincronizar números desde cuenta Twilio
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  try {
    const twilioClient = getTwilioClient();
    const supabase = createAdminClient();

    // Obtener números de Twilio
    const incomingNumbers = await twilioClient.incomingPhoneNumbers.list();

    let created = 0;
    let updated = 0;

    for (const num of incomingNumbers) {
      // Comprobar si ya existe
      const { data: existing } = await supabase
        .from('phone_numbers')
        .select('id')
        .eq('twilio_sid', num.sid)
        .single();

      if (existing) {
        // Actualizar friendly name
        await supabase
          .from('phone_numbers')
          .update({
            phone_number: num.phoneNumber,
            friendly_name: num.friendlyName || null,
          })
          .eq('id', existing.id);
        updated++;
      } else {
        // Crear nuevo
        await supabase.from('phone_numbers').insert({
          twilio_sid: num.sid,
          phone_number: num.phoneNumber,
          friendly_name: num.friendlyName || null,
          ooh_action: 'hangup',
          record_calls: true,
          active: true,
        });
        created++;
      }
    }

    await auditLog('phone_number.synced', 'phone_number', null, auth.userId, {
      total: incomingNumbers.length,
      created,
      updated,
    });

    return apiSuccess({
      total: incomingNumbers.length,
      created,
      updated,
    });
  } catch (err) {
    console.error('Error syncing phone numbers:', err);
    return apiInternalError('Error al sincronizar números con Twilio');
  }
}

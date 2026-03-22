import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateAndParseTwilioWebhook } from '@/lib/api/twilio-auth';
import type { RecordingStatus } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/recording/status
 * Twilio notifica cuando una grabación está lista.
 * Crea un registro en la tabla recordings vinculado al call_record.
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const recordingSid = params.RecordingSid || '';
  const recordingUrl = params.RecordingUrl || '';
  const recordingStatus = params.RecordingStatus || '';
  const recordingDuration = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : null;
  const callSid = params.CallSid || '';

  console.log(`[RECORDING] Sid=${recordingSid} CallSid=${callSid} Status=${recordingStatus} Duration=${recordingDuration}s`);

  if (!recordingSid || !callSid) {
    return new NextResponse('OK', { status: 200 });
  }

  try {
    const supabase = createAdminClient();

    // Buscar el call_record por twilio_call_sid
    const { data: callRecord } = await supabase
      .from('call_records')
      .select('id')
      .eq('twilio_call_sid', callSid)
      .single();

    if (!callRecord) {
      console.warn(`[RECORDING] No se encontró call_record para CallSid=${callSid}`);
      return new NextResponse('OK', { status: 200 });
    }

    // Mapear status de Twilio a nuestro enum
    const statusMap: Record<string, string> = {
      completed: 'completed',
      processing: 'processing',
      failed: 'failed',
      absent: 'failed',
    };
    const mappedStatus = statusMap[recordingStatus] || 'processing';

    // Crear o actualizar registro de grabación
    const { data: existing } = await supabase
      .from('recordings')
      .select('id')
      .eq('twilio_recording_sid', recordingSid)
      .single();

    if (existing) {
      // Actualizar
      await supabase
        .from('recordings')
        .update({
          url: recordingUrl,
          duration: recordingDuration,
          status: mappedStatus as RecordingStatus,
        })
        .eq('id', existing.id);
    } else {
      // Crear nuevo
      await supabase
        .from('recordings')
        .insert({
          twilio_recording_sid: recordingSid,
          call_record_id: callRecord.id,
          url: recordingUrl,
          duration: recordingDuration,
          status: mappedStatus as RecordingStatus,
        });
    }

    console.log(`[RECORDING] Saved recording ${recordingSid} for call ${callRecord.id}`);
  } catch (err) {
    console.error('[RECORDING] Error saving recording:', err);
  }

  return new NextResponse('OK', { status: 200 });
}

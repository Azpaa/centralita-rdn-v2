import { NextRequest, NextResponse } from 'next/server';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { parseTwilioBody } from '@/lib/api/twilio-auth';

/**
 * POST /api/webhooks/twilio/voice/status
 * Twilio llama aquí cuando cambia el estado de una llamada.
 * Actualiza call_records con estado, duración, timestamps, etc.
 *
 * Parámetros que envía Twilio:
 * - CallSid, CallStatus, CallDuration, Timestamp
 * - From, To, Direction
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const params = parseTwilioBody(body);

  const callSid = params.CallSid || params.ParentCallSid || '';
  const callStatus = params.CallStatus || '';
  const callDuration = params.CallDuration ? parseInt(params.CallDuration, 10) : undefined;
  const timestamp = params.Timestamp || new Date().toISOString();

  console.log(`[STATUS] CallSid=${callSid} Status=${callStatus} Duration=${callDuration ?? 'N/A'}`);

  if (!callSid) {
    return new NextResponse('OK', { status: 200 });
  }

  // Mapear estados de Twilio a nuestros estados
  const statusMap: Record<string, string> = {
    queued: 'ringing',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'completed',
    busy: 'busy',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'canceled',
  };

  const mappedStatus = statusMap[callStatus] || callStatus;

  try {
    const updates: Parameters<typeof updateCallStatus>[1] = {};

    updates.status = mappedStatus;

    if (callStatus === 'in-progress') {
      updates.answeredAt = timestamp;
    }

    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      updates.endedAt = timestamp;
      if (callDuration !== undefined) {
        updates.duration = callDuration;
      }
    }

    await updateCallStatus(callSid, updates);
  } catch (err) {
    console.error('[STATUS] Error updating call status:', err);
  }

  // Twilio espera un 200 (no TwiML aquí)
  return new NextResponse('OK', { status: 200 });
}

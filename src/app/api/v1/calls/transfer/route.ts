import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/v1/calls/transfer
 * Transferencia en frío (blind transfer).
 *
 * Soporta DOS modos:
 *
 * A) **Conferencia** (llamadas entrantes con la nueva arquitectura):
 *    - El callSid del agente es una leg independiente en una conferencia.
 *    - No hay relación parent/child con el caller.
 *    - Buscamos el callSid original del caller en call_records (por twilio_call_sid
 *      del record que tiene conference call-{X}).
 *    - Sacamos al caller de la conferencia actualizando su call con TwiML inline.
 *
 * B) **Legacy parent/child** (llamadas salientes y entrantes pre-conferencia):
 *    - Funciona como antes: buscar parentCallSid o children.
 *
 * Body: { callSid: string, destination: string, callerId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: { callSid?: string; destination?: string; callerId?: string };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const { callSid, destination, callerId } = body;
  if (!callSid || !destination) {
    return apiBadRequest('callSid y destination son requeridos');
  }

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  try {
    const client = getTwilioClient();
    const supabase = createAdminClient();

    // ── 1. Identificar la leg remota ──────────────────────────────────────
    // Primero intentar vía conferencia (nueva arquitectura inbound):
    // Buscar el call_record del callSid del agente para saber si está en
    // una conferencia. Si sí, el caller original es el twilio_call_sid de
    // otro call_record inbound asociado a la misma conferencia.
    let remoteCallSid: string | null = null;

    // Intentar encontrar la conferencia activa para este callSid
    const conferenceName = `call-${callSid}`;
    try {
      const conferences = await client.conferences.list({
        friendlyName: conferenceName,
        status: 'in-progress',
        limit: 1,
      });

      if (conferences.length > 0) {
        // Conferencia encontrada — buscar participantes que NO sean el agente
        const participants = await client
          .conferences(conferences[0].sid)
          .participants.list();

        for (const p of participants) {
          if (p.callSid !== callSid) {
            remoteCallSid = p.callSid;
            break;
          }
        }

        if (!remoteCallSid) {
          // El callSid podría no estar directamente en la conferencia
          // (el agente usa device.connect → conference:call-{X}, con un SID diferente).
          // Buscar por exclusión: cualquier participante cuyo SID no sea del agente.
          // Si solo hay 1 participante, ese es el caller.
          if (participants.length === 1) {
            remoteCallSid = participants[0].callSid;
          }
        }

        console.log(
          `[TRANSFER] Conference mode: conf=${conferenceName} participants=${participants.length} remoteSid=${remoteCallSid}`
        );
      }
    } catch (err) {
      // No hay conferencia con ese nombre — intentar búsqueda inversa
      console.log(`[TRANSFER] No conference found for ${conferenceName}, trying DB lookup`);
    }

    // Si no encontramos por conferencia directa, buscar en DB:
    // El call_record inbound original tiene el twilio_call_sid del caller
    if (!remoteCallSid) {
      const { data: record } = await supabase
        .from('call_records')
        .select('twilio_call_sid, direction')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();

      if (record?.direction === 'inbound') {
        // Para inbound en conferencia, el callSid pasado por el widget
        // es el del caller original. La conferencia se llama call-{callerSid}.
        // Verificar si hay conferencia activa con ese nombre.
        try {
          const confs = await client.conferences.list({
            friendlyName: `call-${callSid}`,
            status: 'in-progress',
            limit: 1,
          });
          if (confs.length > 0) {
            // El callSid ES el del caller. remoteCallSid = callSid.
            // Simplemente redirigimos este SID.
            remoteCallSid = callSid;
            console.log(`[TRANSFER] Caller SID matches record: remoteSid=${remoteCallSid}`);
          }
        } catch {
          // ignore
        }
      }
    }

    // Fallback: modo legacy parent/child
    if (!remoteCallSid) {
      const callInfo = await client.calls(callSid).fetch();

      if (callInfo.parentCallSid) {
        remoteCallSid = callInfo.parentCallSid;
      } else {
        const children = await client.calls.list({
          parentCallSid: callSid,
          status: 'in-progress',
          limit: 5,
        });

        if (children.length > 0) {
          remoteCallSid = children[0].sid;
        }
      }
    }

    if (!remoteCallSid) {
      return apiBadRequest(
        'No se encontró la otra parte de la llamada. Puede que ya haya colgado.'
      );
    }

    console.log(
      `[TRANSFER] agentCallSid=${callSid} remoteSid=${remoteCallSid} → ${destination}`
    );

    // ── 2. Construir TwiML inline para la transferencia ──────────────────
    const twimlBuilder = new twilio.twiml.VoiceResponse();

    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Transfiriendo su llamada. Un momento por favor.'
    );

    // <Dial> SIN action URL → al finalizar el Dial, la llamada continúa
    // con los siguientes verbos (despedida + hangup). Así evitamos que
    // dial-action reintente la cola.
    const dial = twimlBuilder.dial({
      callerId: callerId || undefined,
      timeout: 30,
    });

    if (destination.startsWith('client:')) {
      dial.client(destination.replace('client:', ''));
    } else {
      dial.number(destination);
    }

    // Después del Dial (conteste o no), despedirse y colgar.
    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'La transferencia ha finalizado. Gracias por llamar.'
    );
    twimlBuilder.hangup();

    const twimlString = twimlBuilder.toString();

    // ── 3. Redirigir la leg remota con TwiML inline ──────────────────────
    await client.calls(remoteCallSid).update({ twiml: twimlString });

    // ── 4. Colgar la leg del agente explícitamente ───────────────────────
    // Para entrantes: el child (agente) se desconecta automáticamente al
    //   interrumpir el Dial del parent, pero lo completamos por seguridad.
    // Para salientes: evitamos que el parent vaya a dial-action (que podría
    //   reintentar colas o mostrar errores de webhook 401).
    try {
      await client.calls(callSid).update({ status: 'completed' });
    } catch {
      // Ya estaba desconectado — OK
    }

    // Emitir evento call.transferred para RDN
    emitEvent('call.transferred', {
      call_sid: callSid,
      remote_call_sid: remoteCallSid,
      destination,
      transferred_by: auth.userId ?? 'api_key',
    });

    await auditLog('call.transfer', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      remote_call_sid: remoteCallSid,
      destination,
      caller_id: callerId ?? null,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ transferred: true, callSid: remoteCallSid, destination });
  } catch (err) {
    console.error('[TRANSFER] Error:', err);
    return apiInternalError('Error al transferir la llamada');
  }
}

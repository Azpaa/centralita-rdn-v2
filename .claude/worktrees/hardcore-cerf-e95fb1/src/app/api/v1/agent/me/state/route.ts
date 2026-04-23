import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiForbidden, apiNotFound, apiSuccess } from '@/lib/api/response';
import { resolveAgentRuntimeSnapshot } from '@/lib/calls/agent-state';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * GET /api/v1/agent/me/state
 * Estado operativo canonico del agente desde backend (fuente de verdad).
 *
 * - Sesion web: usa auth.userId de la sesion actual.
 * - API key M2M: requiere ?user_id=<uuid>.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let targetUserId = auth.userId;

  if (auth.authMethod === 'api_key') {
    const { searchParams } = new URL(req.url);
    const requestedUserId = searchParams.get('user_id') || '';
    if (!requestedUserId) {
      return apiBadRequest('user_id es requerido para consultar estado de agente con API key');
    }
    if (!isUuid(requestedUserId)) {
      return apiBadRequest('user_id debe ser UUID valido');
    }
    targetUserId = requestedUserId;
  }

  if (!targetUserId) {
    return apiForbidden('No se pudo resolver agente desde la sesion actual');
  }

  const snapshot = await resolveAgentRuntimeSnapshot(targetUserId);
  if (!snapshot) return apiNotFound('Agente');

  return apiSuccess(snapshot);
}


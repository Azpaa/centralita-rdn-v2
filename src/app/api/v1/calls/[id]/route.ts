import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound } from '@/lib/api/response';
import type { CallRecord } from '@/lib/types/database';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/calls/:id — Detalle de llamada
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: call, error } = await supabase
    .from('call_records')
    .select('*')
    .eq('id', id)
    .single<CallRecord>();

  if (error || !call) return apiNotFound('Llamada');

  // Obtener grabaciones de esta llamada
  const { data: recordings } = await supabase
    .from('recordings')
    .select('*')
    .eq('call_record_id', id)
    .order('created_at');

  // Obtener datos del usuario que atendió
  let answeredByUser = null;
  if (call.answered_by_user_id) {
    const { data: user } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', call.answered_by_user_id)
      .single();
    answeredByUser = user;
  }

  return apiSuccess({
    ...call,
    recordings: recordings || [],
    answered_by_user: answeredByUser,
  });
}

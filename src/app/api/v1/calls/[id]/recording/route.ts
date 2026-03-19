import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound } from '@/lib/api/response';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/calls/:id/recording — Obtener grabación de una llamada
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: recordings, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('call_record_id', id)
    .order('created_at');

  if (error || !recordings || recordings.length === 0) {
    return apiNotFound('Grabación');
  }

  return apiSuccess(recordings);
}

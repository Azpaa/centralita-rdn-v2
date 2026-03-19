import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound } from '@/lib/api/response';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/recordings/:id
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return apiNotFound('Grabación');

  return apiSuccess(data);
}

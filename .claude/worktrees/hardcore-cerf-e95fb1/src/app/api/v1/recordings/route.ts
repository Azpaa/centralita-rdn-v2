import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';
import type { RecordingStatus } from '@/lib/types/database';

// GET /api/v1/recordings
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  let query = supabase
    .from('recordings')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status as RecordingStatus);

  const callRecordId = searchParams.get('call_record_id');
  if (callRecordId) query = query.eq('call_record_id', callRecordId);

  query = query.range(skip, skip + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('Error listing recordings:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

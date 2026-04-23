import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';

// GET /api/v1/phone-numbers
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  let query = supabase
    .from('phone_numbers')
    .select('*', { count: 'exact' })
    .order('phone_number');

  const active = searchParams.get('active');
  if (active !== null) query = query.eq('active', active === 'true');

  query = query.range(skip, skip + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('Error listing phone numbers:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

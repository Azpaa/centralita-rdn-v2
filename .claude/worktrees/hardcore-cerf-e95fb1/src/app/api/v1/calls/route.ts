import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';
import { escapeIlike } from '@/lib/api/sanitize';
import type { CallDirection, CallStatus } from '@/lib/types/database';

// GET /api/v1/calls — Listar llamadas con filtros
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  let query = supabase
    .from('call_records')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  // Filtros
  const direction = searchParams.get('direction');
  if (direction) query = query.eq('direction', direction as CallDirection);

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status as CallStatus);

  const queueId = searchParams.get('queue_id');
  if (queueId) query = query.eq('queue_id', queueId);

  const fromNumber = searchParams.get('from_number');
  if (fromNumber) query = query.ilike('from_number', `%${escapeIlike(fromNumber)}%`);

  const toNumber = searchParams.get('to_number');
  if (toNumber) query = query.ilike('to_number', `%${escapeIlike(toNumber)}%`);

  const dateFrom = searchParams.get('date_from');
  if (dateFrom) query = query.gte('started_at', dateFrom);

  const dateTo = searchParams.get('date_to');
  if (dateTo) query = query.lte('started_at', dateTo);

  const answeredBy = searchParams.get('answered_by_user_id');
  if (answeredBy) query = query.eq('answered_by_user_id', answeredBy);

  const twilioCallSid = searchParams.get('twilio_call_sid');
  if (twilioCallSid) query = query.eq('twilio_call_sid', twilioCallSid);

  query = query.range(skip, skip + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('Error listing calls:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

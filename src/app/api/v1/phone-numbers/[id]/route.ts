import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { updatePhoneNumberSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/phone-numbers/:id
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('phone_numbers')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return apiNotFound('Número de teléfono');

  return apiSuccess(data);
}

// PUT /api/v1/phone-numbers/:id
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = updatePhoneNumberSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('phone_numbers')
    .update(parsed.data)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) {
    console.error('Error updating phone number:', error);
    return apiNotFound('Número de teléfono');
  }

  await auditLog('phone_number.updated', 'phone_number', id, auth.userId, parsed.data);

  return apiSuccess(data);
}

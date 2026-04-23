import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiNoContent, apiInternalError } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string; userId: string }>;
}

// DELETE /api/v1/queues/:id/users/:userId — Quitar usuario de cola
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: queueId, userId } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase
    .from('queue_users')
    .delete()
    .eq('queue_id', queueId)
    .eq('user_id', userId);

  if (error) {
    console.error('Error removing user from queue:', error);
    return apiInternalError();
  }

  await auditLog('queue.user_removed', 'queue', queueId, auth.userId, { user_id: userId });

  return apiNoContent();
}

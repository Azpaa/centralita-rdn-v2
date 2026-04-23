import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiInternalError } from '@/lib/api/response';

// GET /api/v1/stats/summary
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  try {
    const supabase = createAdminClient();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();

    // Llamadas hoy
    const { count: callsToday } = await supabase
      .from('call_records')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', todayISO);

    // Llamadas en curso
    const { count: activeCalls } = await supabase
      .from('call_records')
      .select('*', { count: 'exact', head: true })
      .in('status', ['ringing', 'in_queue', 'in_progress']);

    // Usuarios disponibles
    const { count: availableUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('active', true)
      .eq('available', true)
      .is('deleted_at', null);

    // Usuarios totales activos
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('active', true)
      .is('deleted_at', null);

    return apiSuccess({
      calls_today: callsToday || 0,
      active_calls: activeCalls || 0,
      available_users: availableUsers || 0,
      total_users: totalUsers || 0,
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    return apiInternalError();
  }
}

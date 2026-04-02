import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { Sidebar } from '@/components/sidebar';
import { CallWidget } from '@/components/call-widget';
import { CallProvider } from '@/contexts/call-context';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Comprobar si el usuario debe cambiar su contraseña
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('users')
      .select('must_change_password')
      .eq('auth_id', user.id)
      .single();

    if (profile?.must_change_password) {
      redirect('/change-password');
    }
  }

  return (
    <CallProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="relative flex-1 overflow-y-auto">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(79,144,178,0.12),transparent_50%)]" />
          <div className="relative mx-auto max-w-7xl p-6 md:p-8">{children}</div>
        </main>
        <CallWidget />
      </div>
    </CallProvider>
  );
}

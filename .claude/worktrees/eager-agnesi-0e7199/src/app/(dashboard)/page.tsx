'use client';

import { useEffect, useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { PhoneIncoming, PhoneCall, Users, UserCheck, AlertCircle, Download } from 'lucide-react';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

interface Stats {
  calls_today: number;
  active_calls: number;
  available_users: number;
  total_users: number;
}

const POLL_INTERVAL = 30_000; // 30s auto-refresh

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchStats() {
      const res = await api.get<Stats>('/stats/summary', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (res.ok) {
        setStats(res.data);
        setError(null);
      } else {
        setError(res.error || 'Error al cargar estadísticas');
      }
      setLoading(false);
    }

    fetchStats();
    intervalRef.current = setInterval(fetchStats, POLL_INTERVAL);

    return () => {
      controller.abort();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const cards = [
    {
      title: 'Llamadas hoy',
      value: stats?.calls_today ?? 0,
      icon: PhoneIncoming,
      iconClass: 'text-primary',
      iconBgClass: 'bg-primary/12',
    },
    {
      title: 'Llamadas activas',
      value: stats?.active_calls ?? 0,
      icon: PhoneCall,
      iconClass: 'text-primary/90',
      iconBgClass: 'bg-primary/18',
    },
    {
      title: 'Usuarios disponibles',
      value: stats?.available_users ?? 0,
      icon: UserCheck,
      iconClass: 'text-[var(--primary-hover)]',
      iconBgClass: 'bg-secondary',
    },
    {
      title: 'Total usuarios',
      value: stats?.total_users ?? 0,
      icon: Users,
      iconClass: 'text-muted-foreground',
      iconBgClass: 'bg-muted',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Panel RDN</p>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Resumen general de la centralita</p>
        </div>
        <a
          href="/api/download-agent"
          className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}
        >
          <Download className="h-4 w-4" />
          Descargar agente
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {error && (
          <Card className="sm:col-span-2 lg:col-span-4 border-destructive/50">
            <CardContent className="flex items-center gap-2 py-3 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </CardContent>
          </Card>
        )}
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <span className={cn('inline-flex rounded-full p-2', card.iconBgClass)}>
                <card.icon className={cn('h-4.5 w-4.5', card.iconClass)} />
              </span>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold tracking-tight">{loading ? '—' : card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PhoneIncoming, PhoneCall, Users, UserCheck } from 'lucide-react';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

interface Stats {
  calls_today: number;
  active_calls: number;
  available_users: number;
  total_users: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Stats>('/stats/summary').then((res) => {
      if (res.ok) setStats(res.data);
      setLoading(false);
    });
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Panel RDN</p>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Resumen general de la centralita</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

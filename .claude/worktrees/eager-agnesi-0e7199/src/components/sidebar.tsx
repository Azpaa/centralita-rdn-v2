'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Phone,
  Users,
  ListOrdered,
  Clock,
  PhoneIncoming,
  LayoutDashboard,
  LogOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { logout } from '@/lib/actions/auth';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/users', label: 'Usuarios', icon: Users },
  { href: '/queues', label: 'Colas', icon: ListOrdered },
  { href: '/phone-numbers', label: 'Números', icon: Phone },
  { href: '/schedules', label: 'Horarios', icon: Clock },
  { href: '/calls', label: 'Llamadas', icon: PhoneIncoming },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[0_14px_32px_rgba(0,0,0,0.18)]">
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-white/12 ring-1 ring-white/30">
          <Phone className="h-5 w-5 text-white" />
        </div>
        <div className="ml-3">
          <p className="text-[0.65rem] font-semibold tracking-[0.22em] text-sidebar-foreground/75 uppercase">
            RDN
          </p>
          <span className="text-base font-semibold leading-tight text-white">Centralita</span>
        </div>
      </div>

      <nav className="flex-1 space-y-1.5 p-3">
        {navItems.map((item) => {
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-semibold transition-all duration-200',
                isActive
                  ? 'border-white/20 bg-sidebar-accent text-sidebar-accent-foreground shadow-[0_10px_18px_rgba(0,0,0,0.15)]'
                  : 'text-sidebar-foreground/75 hover:border-white/10 hover:bg-white/10 hover:text-white'
              )}
            >
              <item.icon
                className={cn(
                  'h-4 w-4 transition-transform duration-200 group-hover:scale-105',
                  isActive ? 'text-white' : 'text-sidebar-foreground/80'
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <form action={logout}>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 rounded-lg border border-transparent text-sidebar-foreground/80 hover:border-white/10 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Cerrar sesión
          </Button>
        </form>
      </div>
    </aside>
  );
}

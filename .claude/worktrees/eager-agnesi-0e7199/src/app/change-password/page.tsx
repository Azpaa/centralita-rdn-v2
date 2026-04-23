'use client';

import { useState } from 'react';
import { changePassword, logout } from '@/lib/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ShieldAlert } from 'lucide-react';

export default function ChangePasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError(null);
    const result = await changePassword(formData);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(79,144,178,0.26),transparent_44%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,#ffffff_0%,#f2f8fb_100%)]" />

      <Card className="relative w-full max-w-md border-border/90 bg-card/95 shadow-[0_22px_45px_rgba(12,37,56,0.13)] backdrop-blur">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <ShieldAlert className="h-6 w-6 text-amber-600" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Cambiar contraseÃ±a</CardTitle>
          <CardDescription>
            Es necesario cambiar tu contraseÃ±a provisional antes de continuar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">ContraseÃ±a actual (provisional)</Label>
              <Input
                id="currentPassword"
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
                placeholder="La contraseÃ±a que te proporcionaron"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">Nueva contraseÃ±a</Label>
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="MÃ­nimo 8 caracteres"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirmar nueva contraseÃ±a</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="Repite la nueva contraseÃ±a"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="mt-1 w-full" disabled={loading}>
              {loading ? 'Cambiando...' : 'Cambiar contraseÃ±a'}
            </Button>
            <Button
              type="submit"
              formAction={logout}
              variant="ghost"
              className="w-full text-muted-foreground"
            >
              Cerrar sesiÃ³n
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


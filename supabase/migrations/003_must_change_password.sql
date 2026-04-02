-- ============================================
-- Centralita RDN v2.0 — Migración 003
-- Campo must_change_password para forzar cambio
-- en el primer login.
-- Ejecutar en Supabase SQL Editor
-- ============================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Marcar usuarios existentes que NO tienen auth_id (nunca se loguearon)
-- como que deben cambiar contraseña cuando se les cree una cuenta auth.
-- Los que ya tienen auth_id (como el admin) no necesitan cambiarla.
COMMENT ON COLUMN users.must_change_password IS
  'Si true, el usuario será redirigido a /change-password al hacer login';

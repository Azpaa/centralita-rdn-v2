/**
 * Utilidades de sanitización para queries de base de datos.
 */

import { randomBytes } from 'crypto';

/**
 * Genera una contraseña temporal segura.
 * Formato: 4 chars alfanuméricos + "-" + 4 chars + "-" + 4 chars (ej: "aB3k-Xm9p-Qw2z")
 * Siempre cumple: >= 12 chars, mezcla mayúsculas, minúsculas y dígitos.
 */
export function generateTempPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars[bytes[i] % chars.length];
    if (i === 3 || i === 7) password += '-';
  }
  return password;
}

/**
 * Escapa caracteres especiales de PostgreSQL LIKE/ILIKE.
 * Previene inyección de wildcards (%, _, \) en búsquedas de texto.
 *
 * @param input - String del usuario sin sanitizar
 * @returns String seguro para usar en ilike/like
 */
export function escapeIlike(input: string): string {
  return input
    .replace(/\\/g, '\\\\') // \ → \\
    .replace(/%/g, '\\%')   // % → \%
    .replace(/_/g, '\\_');   // _ → \_
}

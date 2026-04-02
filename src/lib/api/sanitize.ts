/**
 * Utilidades de sanitización para queries de base de datos.
 */

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

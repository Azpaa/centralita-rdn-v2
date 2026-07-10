/**
 * Normalización de teléfonos de agente a E.164 para las legs de ring por REST.
 *
 * Contexto: `users.phone` puede llegar sucio (aprovisionado desde RDN u otros
 * orígenes): valores basura ("6", "111111111"), rellenos ("11111111111") o
 * móviles españoles sin prefijo internacional ("648728411"). Antes se pasaban
 * crudos a `twilioClient.calls.create({ to })`, lo que provocaba una llamada
 * REST condenada a fallar en CADA entrante ("... is not valid." / "Account not
 * allowed to call ...") y ruido en logs. El ring al softphone (`client:`) no se
 * ve afectado; esto solo cubre el fallback a teléfono físico.
 *
 * Regla: si no podemos producir un E.164 plausible, devolvemos `null` y el
 * llamador debe SALTARSE la leg de teléfono (nunca llamar a Twilio con basura).
 */

const DEFAULT_COUNTRY_CODE = '34'; // España

/**
 * Convierte un teléfono en bruto a E.164 (`+<indicativo><número>`), o `null`
 * si no es un número plausible.
 *
 * - `+34648728411`, `+34 648 728 411` → `+34648728411` (ya internacional)
 * - `0034648728411`, `34648728411`    → `+34648728411` (prefijo sin `+`)
 * - `648728411`, `948 12 34 56`       → `+34648728411` (9 díg. ES, añade +34)
 * - `6`, `111111111`, `11111111111`   → `null` (basura / longitud imposible)
 * - vacío, no numérico                → `null`
 */
export function toE164Phone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Deja solo dígitos y un posible '+' inicial.
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // Caso ya internacional: '+<...>' o prefijo de salida internacional '00<...>'.
  if (hasPlus) {
    return isPlausibleE164Digits(digits) ? `+${digits}` : null;
  }
  if (digits.startsWith('00')) {
    const intl = digits.slice(2);
    return isPlausibleE164Digits(intl) ? `+${intl}` : null;
  }

  // Número nacional español: 9 dígitos que empiezan por 6/7 (móvil) u 8/9 (fijo).
  if (digits.length === 9 && /^[6789]/.test(digits)) {
    return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  }

  // '34648728411' → interpretamos que ya trae indicativo español sin '+'.
  if (
    digits.length === 11 &&
    digits.startsWith(DEFAULT_COUNTRY_CODE) &&
    /^[6789]/.test(digits.slice(2))
  ) {
    return `+${digits}`;
  }

  // Cualquier otra cosa (demasiado corto, relleno como '11111111111', etc.)
  // no es un teléfono español válido y no nos arriesgamos a inventar prefijo.
  return null;
}

/**
 * Chequeo de plausibilidad E.164 para un número ya internacional (sin '+'):
 * indicativo que empieza por 1-9 y longitud total 8-15 dígitos. Descarta
 * rellenos evidentes como '11111111111' repetido si no fueran plausibles por
 * longitud, pero su función principal es filtrar valores demasiado cortos.
 */
function isPlausibleE164Digits(digits: string): boolean {
  return /^[1-9]\d{7,14}$/.test(digits);
}

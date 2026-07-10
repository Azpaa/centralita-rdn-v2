-- ============================================
-- Centralita RDN v2.0 — Migración 010
-- Normalización de users.phone a E.164 en escritura (defensa en BD)
-- ============================================
--
-- Contexto: users.phone puede llegar sucio (aprovisionado desde RDN u otros
-- orígenes): basura ("6", "111111111"), rellenos ("11111111111") o móviles
-- españoles sin prefijo ("648728411"). Eso genera legs de ring por REST
-- condenadas a fallar en CADA entrante ("... is not valid." / "Account not
-- allowed to call ...") y ruido en logs. El backend ya se blinda en el punto
-- de uso (src/lib/twilio/phone.ts), pero este trigger mantiene además los
-- DATOS limpios pase lo que pase quien escriba en la tabla.
--
-- Regla (espeja toE164Phone en TS):
--   +34648728411 / 0034648728411 / 34648728411 -> +34648728411
--   648728411 (9 díg. ES 6/7/8/9)              -> +34648728411
--   6 / 111111111 / 11111111111 / basura        -> NULL
-- Idempotente: un valor ya normalizado se queda igual.

CREATE OR REPLACE FUNCTION normalize_agent_phone(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed  text;
  has_plus boolean;
  digits   text;
  intl     text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;

  trimmed  := btrim(raw);
  has_plus := left(trimmed, 1) = '+';
  digits   := regexp_replace(trimmed, '\D', '', 'g');

  IF digits = '' THEN
    RETURN NULL;
  END IF;

  -- Ya internacional con '+'
  IF has_plus THEN
    IF digits ~ '^[1-9]\d{7,14}$' THEN
      RETURN '+' || digits;
    END IF;
    RETURN NULL;
  END IF;

  -- Prefijo de salida internacional '00...'
  IF left(digits, 2) = '00' THEN
    intl := substring(digits from 3);
    IF intl ~ '^[1-9]\d{7,14}$' THEN
      RETURN '+' || intl;
    END IF;
    RETURN NULL;
  END IF;

  -- Nacional español: 9 dígitos que empiezan por 6/7 (móvil) u 8/9 (fijo)
  IF length(digits) = 9 AND digits ~ '^[6789]' THEN
    RETURN '+34' || digits;
  END IF;

  -- '34648728411' -> indicativo español sin '+'
  IF length(digits) = 11 AND left(digits, 2) = '34' AND substring(digits from 3) ~ '^[6789]' THEN
    RETURN '+' || digits;
  END IF;

  -- Cualquier otra cosa: no inventamos prefijo.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION normalize_agent_phone(text) IS
  'Normaliza un teléfono de agente a E.164 (+34 por defecto) o NULL si no es plausible. Espeja src/lib/twilio/phone.ts::toE164Phone.';

CREATE OR REPLACE FUNCTION users_normalize_phone_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone := normalize_agent_phone(NEW.phone);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_normalize_phone ON users;

CREATE TRIGGER trg_users_normalize_phone
  BEFORE INSERT OR UPDATE OF phone ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_normalize_phone_trigger();

COMMENT ON TRIGGER trg_users_normalize_phone ON users IS
  'Normaliza users.phone a E.164 (o NULL) en cada escritura. Defensa contra números basura aprovisionados desde RDN u otros orígenes.';

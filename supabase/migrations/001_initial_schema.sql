-- ============================================
-- Centralita RDN v2.0 — Migración inicial
-- Ejecutar en Supabase SQL Editor
-- ============================================

-- =====================
-- 1. ENUMS
-- =====================

CREATE TYPE user_role AS ENUM ('admin', 'operator');
CREATE TYPE queue_strategy AS ENUM ('ring_all', 'round_robin');
CREATE TYPE timeout_action AS ENUM ('hangup', 'forward', 'voicemail', 'keep_waiting');
CREATE TYPE ooh_action AS ENUM ('hangup', 'forward', 'voicemail');
CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE call_status AS ENUM ('ringing', 'in_queue', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled');
CREATE TYPE recording_status AS ENUM ('processing', 'completed', 'failed', 'deleted');

-- =====================
-- 2. TABLAS
-- =====================

-- Usuarios
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  phone text,
  role user_role NOT NULL DEFAULT 'operator',
  available boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  rdn_user_id text UNIQUE,
  rdn_linked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Colas
CREATE TABLE queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  strategy queue_strategy NOT NULL DEFAULT 'ring_all',
  ring_timeout integer NOT NULL DEFAULT 25,
  max_wait_time integer NOT NULL DEFAULT 180,
  wait_message text,
  wait_music_url text,
  timeout_action timeout_action NOT NULL DEFAULT 'hangup',
  timeout_forward_to text,
  rotation_interval integer NOT NULL DEFAULT 15,
  current_index integer NOT NULL DEFAULT 0,
  last_rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Usuarios en colas
CREATE TABLE queue_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(queue_id, user_id)
);

-- Horarios
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Slots de horario
CREATE TABLE schedule_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  day_of_week integer NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time)
);

-- Números de teléfono
CREATE TABLE phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_sid text UNIQUE NOT NULL,
  phone_number text UNIQUE NOT NULL,
  friendly_name text,
  queue_id uuid REFERENCES queues(id) ON DELETE SET NULL,
  forward_to text,
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  welcome_message text,
  ooh_message text,
  ooh_action ooh_action NOT NULL DEFAULT 'hangup',
  ooh_forward_to text,
  record_calls boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Registro de llamadas
CREATE TABLE call_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_call_sid text UNIQUE,
  direction call_direction NOT NULL,
  from_number text NOT NULL,
  to_number text NOT NULL,
  status call_status NOT NULL DEFAULT 'ringing',
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration integer,
  wait_time integer,
  queue_id uuid REFERENCES queues(id) ON DELETE SET NULL,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  answered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  twilio_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Grabaciones
CREATE TABLE recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_recording_sid text UNIQUE NOT NULL,
  call_record_id uuid NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  url text NOT NULL,
  duration integer,
  status recording_status NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- API Keys
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text UNIQUE NOT NULL,
  prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- Logs de auditoría
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================
-- 3. ÍNDICES
-- =====================

CREATE INDEX idx_call_records_created_at ON call_records(created_at DESC);
CREATE INDEX idx_call_records_from_number ON call_records(from_number);
CREATE INDEX idx_call_records_queue_id ON call_records(queue_id);
CREATE INDEX idx_call_records_status ON call_records(status);
CREATE INDEX idx_call_records_phone_number_id ON call_records(phone_number_id);
CREATE INDEX idx_recordings_call_record_id ON recordings(call_record_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_users_rdn_user_id ON users(rdn_user_id);
CREATE INDEX idx_users_active_available ON users(active, available);
CREATE INDEX idx_queue_users_queue_id ON queue_users(queue_id);
CREATE INDEX idx_queue_users_user_id ON queue_users(user_id);

-- =====================
-- 4. TRIGGER updated_at
-- =====================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_queues_updated_at
  BEFORE UPDATE ON queues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_schedules_updated_at
  BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_phone_numbers_updated_at
  BEFORE UPDATE ON phone_numbers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_call_records_updated_at
  BEFORE UPDATE ON call_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_recordings_updated_at
  BEFORE UPDATE ON recordings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================
-- 5. RLS (Row Level Security)
-- =====================

-- Activar RLS en todas las tablas
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas: permitir todo para service_role (backend usa service_role key)
-- Para usuarios autenticados del panel, permitir lectura de lo básico

-- Service role ya bypasa RLS por defecto.
-- Para el panel web (anon key con sesión de usuario):

CREATE POLICY "Authenticated users can read users"
  ON users FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL);

CREATE POLICY "Authenticated users can read queues"
  ON queues FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read queue_users"
  ON queue_users FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read schedules"
  ON schedules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read schedule_slots"
  ON schedule_slots FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read phone_numbers"
  ON phone_numbers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read call_records"
  ON call_records FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read recordings"
  ON recordings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read api_keys (no hash)"
  ON api_keys FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read audit_logs"
  ON audit_logs FOR SELECT
  TO authenticated
  USING (true);

-- Admins pueden escribir (las operaciones de escritura van por API routes con service_role)
-- No necesitamos políticas de INSERT/UPDATE/DELETE para authenticated porque
-- todas las escrituras pasan por las API routes que usan el admin client (service_role).

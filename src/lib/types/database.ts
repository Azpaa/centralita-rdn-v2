/**
 * Tipos generados manualmente del esquema de Supabase.
 * Estos tipos se mantendrán sincronizados con las migraciones SQL.
 */

// --- Enums ---

export type UserRole = 'admin' | 'operator';
export type QueueStrategy = 'ring_all' | 'round_robin';
export type TimeoutAction = 'hangup' | 'forward' | 'voicemail' | 'keep_waiting';
export type OohAction = 'hangup' | 'forward' | 'voicemail';
export type CallDirection = 'inbound' | 'outbound';
export type CallStatus =
  | 'pending_agent'
  | 'ringing'
  | 'in_queue'
  | 'in_progress'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'canceled'
  | 'forwarded'
  | 'voicemail';
export type RecordingStatus = 'processing' | 'completed' | 'failed' | 'deleted';

// --- Nuevas tablas de integración RDN ---

export type WebhookSubscription = {
  id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  description: string | null;
  api_key_id: string | null;
  failure_count: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookDeliveryLog = {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  delivered: boolean;
  created_at: string;
};

export type DomainEvent = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  agent_user_id: string | null;
  target_user_ids: string[];
  call_sid: string | null;
  call_record_id: string | null;
  created_at: string;
  expires_at: string;
};

export type TwilioWebhookEvent = {
  id: string;
  call_sid: string;
  call_status: string;
  account_sid: string;
  source: string;
  payload: Record<string, unknown>;
  received_at: string;
  expires_at: string;
};

// Written by the Supabase edge `reconcile-calls` function when it self-heals
// a stuck call. The Next.js app drains this table via
// `drainReconcileOutbox` and re-emits each row through the canonical
// `emitEvent` pipeline, so RDN webhooks and SSE subscribers get notified.
export type ReconcileEventOutboxRow = {
  id: number;
  call_sid: string;
  event: 'call.completed' | 'call.missed';
  payload: Record<string, unknown>;
  created_at: string;
  delivered_at: string | null;
};

// --- Tablas (type alias, no interface, para compatibilidad con Record<string, unknown>) ---

export type User = {
  id: string;
  auth_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  available: boolean;
  active: boolean;
  must_change_password: boolean;
  rdn_user_id: string | null;
  rdn_linked: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Queue = {
  id: string;
  name: string;
  strategy: QueueStrategy;
  ring_timeout: number;
  max_wait_time: number;
  wait_message: string | null;
  wait_music_url: string | null;
  timeout_action: TimeoutAction;
  timeout_forward_to: string | null;
  rotation_interval: number;
  current_index: number;
  last_rotated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type QueueUser = {
  id: string;
  queue_id: string;
  user_id: string;
  priority: number;
  created_at: string;
};

export type Schedule = {
  id: string;
  name: string;
  timezone: string;
  created_at: string;
  updated_at: string;
};

export type ScheduleSlot = {
  id: string;
  schedule_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  created_at: string;
};

export type PhoneNumber = {
  id: string;
  twilio_sid: string;
  phone_number: string;
  friendly_name: string | null;
  queue_id: string | null;
  forward_to: string | null;
  schedule_id: string | null;
  welcome_message: string | null;
  ooh_message: string | null;
  ooh_action: OohAction;
  ooh_forward_to: string | null;
  record_calls: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type CallRecord = {
  id: string;
  twilio_call_sid: string | null;
  direction: CallDirection;
  from_number: string;
  to_number: string;
  status: CallStatus;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration: number | null;
  wait_time: number | null;
  queue_id: string | null;
  phone_number_id: string | null;
  answered_by_user_id: string | null;
  twilio_data: Record<string, unknown> | null;
  last_webhook_at: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Recording = {
  id: string;
  twilio_recording_sid: string;
  call_record_id: string;
  url: string;
  duration: number | null;
  status: RecordingStatus;
  created_at: string;
  updated_at: string;
};

export type ApiKey = {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  user_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

// --- Database type para Supabase client ---

export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Omit<User, 'id' | 'created_at' | 'updated_at' | 'auth_id' | 'phone' | 'rdn_user_id' | 'deleted_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          auth_id?: string | null;
          phone?: string | null;
          rdn_user_id?: string | null;
          deleted_at?: string | null;
        };
        Update: Partial<Omit<User, 'id' | 'created_at'>>;
        Relationships: [];
      };
      queues: {
        Row: Queue;
        Insert: Omit<Queue, 'id' | 'created_at' | 'updated_at' | 'wait_message' | 'wait_music_url' | 'timeout_forward_to' | 'current_index' | 'last_rotated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          wait_message?: string | null;
          wait_music_url?: string | null;
          timeout_forward_to?: string | null;
          current_index?: number;
          last_rotated_at?: string | null;
        };
        Update: Partial<Omit<Queue, 'id' | 'created_at'>>;
        Relationships: [];
      };
      queue_users: {
        Row: QueueUser;
        Insert: Omit<QueueUser, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<QueueUser, 'id' | 'created_at'>>;
        Relationships: [];
      };
      schedules: {
        Row: Schedule;
        Insert: Omit<Schedule, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<Schedule, 'id' | 'created_at'>>;
        Relationships: [];
      };
      schedule_slots: {
        Row: ScheduleSlot;
        Insert: Omit<ScheduleSlot, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<ScheduleSlot, 'id' | 'created_at'>>;
        Relationships: [];
      };
      phone_numbers: {
        Row: PhoneNumber;
        Insert: Omit<PhoneNumber, 'id' | 'created_at' | 'updated_at' | 'friendly_name' | 'queue_id' | 'forward_to' | 'schedule_id' | 'welcome_message' | 'ooh_message' | 'ooh_forward_to'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          friendly_name?: string | null;
          queue_id?: string | null;
          forward_to?: string | null;
          schedule_id?: string | null;
          welcome_message?: string | null;
          ooh_message?: string | null;
          ooh_forward_to?: string | null;
        };
        Update: Partial<Omit<PhoneNumber, 'id' | 'created_at'>>;
        Relationships: [];
      };
      call_records: {
        Row: CallRecord;
        Insert: Omit<CallRecord, 'id' | 'created_at' | 'updated_at' | 'twilio_call_sid' | 'answered_at' | 'ended_at' | 'duration' | 'wait_time' | 'queue_id' | 'phone_number_id' | 'answered_by_user_id' | 'twilio_data' | 'last_webhook_at' | 'last_verified_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          twilio_call_sid?: string | null;
          answered_at?: string | null;
          ended_at?: string | null;
          duration?: number | null;
          wait_time?: number | null;
          queue_id?: string | null;
          phone_number_id?: string | null;
          answered_by_user_id?: string | null;
          twilio_data?: Record<string, unknown> | null;
          last_webhook_at?: string | null;
          last_verified_at?: string | null;
        };
        Update: Partial<Omit<CallRecord, 'id' | 'created_at'>>;
        Relationships: [];
      };
      recordings: {
        Row: Recording;
        Insert: Omit<Recording, 'id' | 'created_at' | 'updated_at' | 'duration'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          duration?: number | null;
        };
        Update: Partial<Omit<Recording, 'id' | 'created_at'>>;
        Relationships: [];
      };
      api_keys: {
        Row: ApiKey;
        Insert: Omit<ApiKey, 'id' | 'created_at' | 'last_used_at'> & {
          id?: string;
          created_at?: string;
          last_used_at?: string | null;
        };
        Update: Partial<Omit<ApiKey, 'id' | 'created_at'>>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, 'id' | 'created_at' | 'entity_id' | 'user_id' | 'details'> & {
          id?: string;
          created_at?: string;
          entity_id?: string | null;
          user_id?: string | null;
          details?: Record<string, unknown> | null;
        };
        Update: Partial<AuditLog>;
        Relationships: [];
      };
      webhook_subscriptions: {
        Row: WebhookSubscription;
        Insert: Omit<WebhookSubscription, 'id' | 'created_at' | 'updated_at' | 'failure_count' | 'last_success_at' | 'last_failure_at' | 'description' | 'api_key_id'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          failure_count?: number;
          last_success_at?: string | null;
          last_failure_at?: string | null;
          description?: string | null;
          api_key_id?: string | null;
        };
        Update: Partial<Omit<WebhookSubscription, 'id' | 'created_at'>>;
        Relationships: [];
      };
      webhook_delivery_log: {
        Row: WebhookDeliveryLog;
        Insert: Omit<WebhookDeliveryLog, 'id' | 'created_at' | 'response_status' | 'response_body' | 'error_message' | 'attempts' | 'next_retry_at' | 'delivered'> & {
          id?: string;
          created_at?: string;
          response_status?: number | null;
          response_body?: string | null;
          error_message?: string | null;
          attempts?: number;
          max_attempts?: number;
          next_retry_at?: string | null;
          delivered?: boolean;
        };
        Update: Partial<Omit<WebhookDeliveryLog, 'id' | 'created_at'>>;
        Relationships: [];
      };
      domain_events: {
        Row: DomainEvent;
        Insert: Omit<DomainEvent, 'id' | 'created_at' | 'expires_at' | 'agent_user_id' | 'target_user_ids' | 'call_sid' | 'call_record_id'> & {
          id?: string;
          created_at?: string;
          expires_at?: string;
          agent_user_id?: string | null;
          target_user_ids?: string[];
          call_sid?: string | null;
          call_record_id?: string | null;
        };
        Update: Partial<Omit<DomainEvent, 'id'>>;
        Relationships: [];
      };
      twilio_webhook_events: {
        Row: TwilioWebhookEvent;
        Insert: Omit<TwilioWebhookEvent, 'id' | 'received_at' | 'expires_at'> & {
          id?: string;
          received_at?: string;
          expires_at?: string;
        };
        Update: Partial<Omit<TwilioWebhookEvent, 'id'>>;
        Relationships: [];
      };
      reconcile_event_outbox: {
        Row: ReconcileEventOutboxRow;
        Insert: Omit<ReconcileEventOutboxRow, 'id' | 'created_at' | 'delivered_at'> & {
          id?: number;
          created_at?: string;
          delivered_at?: string | null;
        };
        Update: Partial<Omit<ReconcileEventOutboxRow, 'id'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      user_role: UserRole;
      queue_strategy: QueueStrategy;
      timeout_action: TimeoutAction;
      ooh_action: OohAction;
      call_direction: CallDirection;
      call_status: CallStatus;
      recording_status: RecordingStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

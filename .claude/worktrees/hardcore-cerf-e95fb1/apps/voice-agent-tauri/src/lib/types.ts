export type BackendOperationalStatus =
  | 'inactive'
  | 'unavailable'
  | 'ready'
  | 'ringing'
  | 'busy_in_call';

export type BootstrapPayload = {
  app: {
    id: string;
    name: string;
  };
  backend: {
    base_url: string;
    api_base_path: string;
    stream_events_path: string;
    agent_state_path: string;
    call_commands_base_path: string;
  };
  auth: {
    mode: 'supabase_jwt';
    supabase_url: string;
    supabase_anon_key: string;
    note: string;
  };
  distribution: {
    download_index_url: string;
    releases_latest_url: string;
    public_artifacts_base_url: string;
  };
};

export type AgentStateSnapshot = {
  user_id: string;
  available?: boolean;
  operational_status: BackendOperationalStatus;
  active_calls_count: number;
  active_calls: Array<{
    call_sid: string | null;
    direction: string;
    status: string;
    from: string;
    to: string;
  }>;
  source_of_truth: string;
  generated_at: string;
};

export type CanonicalStreamEvent = {
  id: string;
  type: string;
  timestamp: string;
  domain_event?: string;
  call_sid?: string | null;
  agent_user_id?: string | null;
  target_user_ids?: string[];
  payload?: Record<string, unknown> & {
    agent_state?: AgentStateSnapshot | null;
  };
};

export type VoiceCallView = {
  callSid: string;
  direction: string;
  status: string;
  from: string | null;
  to: string | null;
  muted: boolean;
};

export type VoiceDeviceStatus =
  | 'connected'
  | 'registering'
  | 'reconnecting'
  | 'degraded'
  | 'disconnected';

export type VoiceTokenPayload = {
  token: string;
  identity: string;
  userName: string;
};

export type CallRecordLookup = {
  id: string;
  direction: 'inbound' | 'outbound' | string;
  from_number: string;
  to_number: string;
  answered_by_user_id: string | null;
  twilio_call_sid: string;
  twilio_data: Record<string, unknown> | null;
};

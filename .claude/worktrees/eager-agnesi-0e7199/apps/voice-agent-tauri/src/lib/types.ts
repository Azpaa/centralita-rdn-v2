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
    // Canonical conference room (if any) — needed by Tauri to join media via
    // device.connect({ To: 'conference:<name>' }). Always present for inbound
    // calls routed through a queue; may be null for legacy direct dials.
    conference_name?: string | null;
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

// Explicit state machine for calls as the UI and engine see them.
//
//   ringing      — inbound, not accepted (ringtone on, Accept enabled)
//   accepting    — user clicked Accept; media path not yet confirmed
//   connected    — media flowing (Twilio Call 'accept' event fired)
//   hanging_up   — hangup in flight; awaiting backend ack
//   ended        — terminal (brief display before being dropped from list)
//
// Previously the UI multiplexed backend status + local presence + ad-hoc
// flags. The explicit phase eliminates several race conditions — notably
// the "you accepted but no audio" bug where phase went straight to
// connected because stopIncomingRingtone was called before media was
// confirmed.
export type CallPhase =
  | 'ringing'
  | 'accepting'
  | 'connected'
  | 'hanging_up'
  | 'ended';

export type VoiceCallView = {
  callSid: string;
  direction: string;
  status: string;
  from: string | null;
  to: string | null;
  muted: boolean;
  phase: CallPhase;
  // Canonical conference room, propagated from SSE incoming_call events and
  // the agent-state snapshot. Needed by the Accept flow to know which room
  // to join without maintaining a separate in-memory Map.
  conferenceName: string | null;
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

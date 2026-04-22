import { createAdminClient } from '@/lib/supabase/admin';

// Idempotency for Twilio webhook callbacks.
//
// Twilio retries on 5xx and on client-timeouts, which in the past
// produced duplicate `call.completed` emissions (same CallSid + same
// CallStatus processed twice seconds apart, each emitting a fresh
// `call.completed` event and confusing downstream agents about when
// the call actually ended).
//
// The rule: a given (CallSid, CallStatus, AccountSid) tuple must be
// processed exactly once. We enforce it via a UNIQUE index on
// twilio_webhook_events and treat an ON CONFLICT as "already seen".
//
// This helper is fire-and-log — callers receive a boolean and decide
// whether to early-return a 200 (telling Twilio we got it) without
// rerunning side effects.

export type TwilioWebhookIdempotencyResult =
  | { duplicate: false }
  | { duplicate: true; firstSeenAt: string | null };

export async function claimTwilioWebhookEvent(args: {
  callSid: string;
  callStatus: string;
  accountSid: string;
  source: string;
  payload: Record<string, unknown>;
}): Promise<TwilioWebhookIdempotencyResult> {
  if (!args.callSid || !args.callStatus || !args.accountSid) {
    // Not enough info to dedup — let the caller process it. These
    // partial callbacks (e.g. conference status without CallStatus)
    // don't need idempotency.
    return { duplicate: false };
  }

  const supabase = createAdminClient();

  const { error } = await supabase
    .from('twilio_webhook_events')
    .insert({
      call_sid: args.callSid,
      call_status: args.callStatus,
      account_sid: args.accountSid,
      source: args.source,
      payload: args.payload,
    });

  if (!error) return { duplicate: false };

  // Postgres error code 23505 = unique_violation. That's the happy
  // path: means Twilio already retried the same callback and we
  // processed it. Any other error we surface as "not duplicate" so
  // the caller runs the handler (failing open is safer than failing
  // closed when our idempotency table is down).
  const errorCode = (error as { code?: string }).code;
  if (errorCode === '23505') {
    // Best-effort lookup of the first-seen timestamp for observability.
    let firstSeenAt: string | null = null;
    try {
      const { data } = await supabase
        .from('twilio_webhook_events')
        .select('received_at')
        .eq('call_sid', args.callSid)
        .eq('call_status', args.callStatus)
        .eq('account_sid', args.accountSid)
        .maybeSingle();
      firstSeenAt = data?.received_at ?? null;
    } catch {
      // no-op
    }
    return { duplicate: true, firstSeenAt };
  }

  console.warn(`[TWILIO-IDEMPOTENCY] Failing open on insert error (${errorCode}):`, error);
  return { duplicate: false };
}

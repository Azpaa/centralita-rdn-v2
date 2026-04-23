import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type CandidateCall = {
  id: string;
  twilio_call_sid: string | null;
  direction: "inbound" | "outbound";
  status: string;
  started_at: string | null;
  from_number: string | null;
  to_number: string | null;
  queue_id: string | null;
  answered_by_user_id: string | null;
  twilio_data: Record<string, unknown> | null;
};

const TERMINAL_TWILIO = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const WAITING_STATUSES = ["ringing", "in_queue"];
const IN_PROGRESS_MINUTES = 30;
const WAITING_MINUTES = 10;
const BATCH_LIMIT = 200;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const CRON_SECRET = Deno.env.get("CRON_SECRET");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !CRON_SECRET) {
  throw new Error("Missing required env vars for reconcile-calls");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function twilioToDbStatus(status: string): string {
  if (status === "no-answer") return "no_answer";
  if (status === "in-progress") return "in_progress";
  return status;
}

function toIsoOrNow(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

async function fetchTwilioCallStatus(callSid: string): Promise<{ ok: true; status: string; endTime: string; duration: number } | { ok: false; reason: string }> {
  const auth = "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
      {
        method: "GET",
        headers: { Authorization: auth },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return { ok: false, reason: `twilio_http_${response.status}` };
    }

    const payload = await response.json();
    const status = String(payload?.status ?? "").toLowerCase();
    const endTime = toIsoOrNow(payload?.end_time);
    const duration = Number.parseInt(String(payload?.duration ?? "0"), 10) || 0;
    return { ok: true, status, endTime, duration };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "twilio_fetch_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  let runId: number | null = null;
  let checked = 0;
  let reconciled = 0;

  try {
    const runIns = await supabase
      .from("reconcile_runs")
      .insert({ status: "running" })
      .select("id")
      .single();

    if (runIns.error) {
      if ((runIns.error as { code?: string }).code === "23505") {
        return jsonResponse({ ok: true, skipped: "already_running" }, 202);
      }
      throw runIns.error;
    }

    runId = runIns.data.id as number;

    const inProgressBefore = new Date(Date.now() - IN_PROGRESS_MINUTES * 60_000).toISOString();
    const waitingBefore = new Date(Date.now() - WAITING_MINUTES * 60_000).toISOString();

    const [stuckInProgressRes, stuckWaitingRes] = await Promise.all([
      supabase
        .from("call_records")
        .select("id, twilio_call_sid, direction, status, started_at, from_number, to_number, queue_id, answered_by_user_id, twilio_data")
        .eq("status", "in_progress")
        .is("ended_at", null)
        .lt("started_at", inProgressBefore)
        .limit(BATCH_LIMIT),
      supabase
        .from("call_records")
        .select("id, twilio_call_sid, direction, status, started_at, from_number, to_number, queue_id, answered_by_user_id, twilio_data")
        .in("status", WAITING_STATUSES)
        .is("ended_at", null)
        .lt("started_at", waitingBefore)
        .limit(BATCH_LIMIT),
    ]);

    if (stuckInProgressRes.error) throw stuckInProgressRes.error;
    if (stuckWaitingRes.error) throw stuckWaitingRes.error;

    const dedup = new Map<string, CandidateCall>();
    for (const c of (stuckInProgressRes.data ?? []) as CandidateCall[]) dedup.set(c.id, c);
    for (const c of (stuckWaitingRes.data ?? []) as CandidateCall[]) dedup.set(c.id, c);
    const candidates = Array.from(dedup.values()).slice(0, BATCH_LIMIT);

    for (const call of candidates) {
      const sid = call.twilio_call_sid ?? "";
      if (!sid || sid.startsWith("pending-")) continue;

      checked++;
      const twilio = await fetchTwilioCallStatus(sid);
      if (!twilio.ok) continue;
      if (!TERMINAL_TWILIO.has(twilio.status)) continue;

      const newStatus = twilioToDbStatus(twilio.status);
      const mergedTwilioData = {
        ...(call.twilio_data && typeof call.twilio_data === "object" ? call.twilio_data : {}),
        reconciled_by: "supabase_edge",
        reconciled_at: new Date().toISOString(),
        twilio_terminal_status: twilio.status,
      };

      const upd = await supabase
        .from("call_records")
        .update({
          status: newStatus,
          ended_at: twilio.endTime,
          duration: twilio.duration,
          twilio_data: mergedTwilioData,
        })
        .eq("id", call.id)
        .is("ended_at", null);

      if (upd.error) continue;

      reconciled++;

      const event = call.direction === "inbound" && newStatus !== "completed"
        ? "call.missed"
        : "call.completed";

      await supabase.from("reconcile_event_outbox").insert({
        call_sid: sid,
        event,
        payload: {
          call_sid: sid,
          direction: call.direction,
          status: newStatus,
          from: call.from_number,
          to: call.to_number,
          queue_id: call.queue_id,
          answered_by_user_id: call.answered_by_user_id,
          duration: twilio.duration,
          ended_at: twilio.endTime,
          reconciled: true,
        },
      });
    }

    await supabase
      .from("reconcile_runs")
      .update({
        status: "ok",
        finished_at: new Date().toISOString(),
        checked_count: checked,
        reconciled_count: reconciled,
      })
      .eq("id", runId);

    return jsonResponse({ ok: true, run_id: runId, checked, reconciled });
  } catch (err) {
    if (runId) {
      await supabase
        .from("reconcile_runs")
        .update({
          status: "error",
          finished_at: new Date().toISOString(),
          checked_count: checked,
          reconciled_count: reconciled,
          error_text: err instanceof Error ? err.message : String(err),
        })
        .eq("id", runId);
    }
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

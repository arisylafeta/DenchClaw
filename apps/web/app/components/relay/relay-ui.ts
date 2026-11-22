/** Small pieces every Relay screen uses. */

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

const PALETTE = ["#2563EB", "#0EA5E9", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0D9488", "#4F46E5", "#B45309"];
/** A person's avatar colour: the same on every screen. */
export const colour = (name: string) => PALETTE[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
export const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
export const firstName = (name: string | null | undefined) => (name ?? "").split(/[\s@]/)[0] || "them";
/** firstName without the comma of "Abhishek, R3 Robotics". */
export const firstOf = (name: string | null | undefined) => firstName(name).replace(/[,;:]+$/, "") || "them";

/** A refused API call: the server's words, and its status so a caller can tell "busy" (409) from "can't start" (503). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const statusOf = (err: unknown) => (err instanceof ApiError ? err.status : null);

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, { method: init?.method ?? "GET", headers: init?.body ? { "content-type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined, cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? "Something went wrong. Try again.", res.status);
  return data as T;
}

/** Plain words for why a send didn't go out. */
export function failureText(failure: { reason: string; detail?: unknown } | null, state: string): string {
  const detail = (failure?.detail ?? {}) as { cause?: string; rule?: string; refused?: string };
  const reason = detail.cause ?? detail.refused ?? failure?.reason ?? state;
  const words: Record<string, string> = {
    thread_has_reply: "they replied since this was drafted. Read their reply first.",
    gmail_auth_unavailable: "Gmail login check failed. Try again in a minute.",
    gmail_send_as_missing: 'Gmail can\'t send from this address yet. Add it in Gmail under Settings, Accounts, "Send mail as", or pick another From.',
    gmail_read_failed: "couldn't read Gmail to check for new replies. Try again.",
    approval_digest_mismatch: "the draft changed while sending. Check it and send again.",
    reply_mailbox_unavailable: "couldn't find the mailbox to check for replies.",
    gmail_reply_anchor_missing: "couldn't find the email it replies to.",
    recipient_suppressed: "the recipient is on the do-not-email list.",
    not_sent_released: "an earlier attempt didn't go out. It's ready to send again.",
    send_timed_out: "the send took too long. Use Check if it went.",
    unknown: "Gmail didn't confirm. Use Check if it went.",
    failed: "Gmail refused it. Use Check if it went.",
    preflight_error: "a pre-send check failed. Try again.",
    schedule_changed: "the draft changed after you scheduled it. Check it and send or schedule again.",
    schedule_missed: "the scheduled time passed while Relay was down. Send it now or pick a new time.",
    schedule_invalid: "the schedule was incomplete. Schedule it again.",
  };
  return words[reason] ?? `${reason.replace(/_/g, " ")}.`;
}

import "server-only";

import { readFileSync } from "node:fs";
import * as postmark from "postmark";
import { getPostmarkClient } from "./client";
import { getPostmarkEnv } from "@/lib/platform-admin/env";

export type EmailResult =
  | { success: true; messageId: string }
  | {
      success: false;
      error: "inactive_recipient" | "rate_limit" | "auth" | "stopped" | "unknown";
      detail?: string;
    };

/** The Postmark emergency stop shared with the mail tool (`rebattery-mail postmark-stop on|off|status`). */
const STOP_FILE = "/root/.hermes/workspace/mail-postmark-stop.json";

/** Who stopped Postmark sending and why, while the stop is on; null otherwise. An unreadable stop file still stops. */
export function postmarkStop(): { by?: string; reason?: string } | null {
  let text: string;
  try { text = readFileSync(process.env.REBATTERY_MAIL_POSTMARK_STOP_FILE || STOP_FILE, "utf8"); } catch { return null; }
  try { return JSON.parse(text) as { by?: string; reason?: string }; } catch { return { reason: "stop file present" }; }
}

/**
 * Send a raw HTML email via Postmark.
 * Never throws — returns a discriminated EmailResult so callers can
 * handle failures without try/catch.
 */
export async function sendRawEmail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  tag?: string;
}): Promise<EmailResult> {
  const { to, subject, html, tag } = params;
  const env = getPostmarkEnv();
  const from = params.from ?? env.postmarkFromEmail;
  const text = params.text ?? stripHtml(html);

  const stopped = postmarkStop();
  if (stopped) {
    return { success: false, error: "stopped", detail: `Postmark sending is stopped${stopped.by ? ` by ${stopped.by}` : ""}${stopped.reason ? `: ${stopped.reason}` : ""}` };
  }

  try {
    const client = getPostmarkClient();
    const response = await client.sendEmail({
      From: from,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      ...(tag ? { Tag: tag } : {}),
    });
    return { success: true, messageId: response.MessageID };
  } catch (err) {
    if (err instanceof postmark.Errors.InactiveRecipientsError) {
      return { success: false, error: "inactive_recipient", detail: err.message };
    }
    if (err instanceof postmark.Errors.RateLimitExceededError) {
      return { success: false, error: "rate_limit", detail: err.message };
    }
    if (err instanceof postmark.Errors.InvalidAPIKeyError) {
      return { success: false, error: "auth", detail: err.message };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { success: false, error: "unknown", detail };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

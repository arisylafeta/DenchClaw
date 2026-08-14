import "server-only";

import * as postmark from "postmark";
import { getPostmarkClient } from "./client";
import { getPostmarkEnv } from "@/lib/platform-admin/env";

export type EmailResult =
  | { success: true; messageId: string }
  | {
      success: false;
      error: "inactive_recipient" | "rate_limit" | "auth" | "unknown";
      detail?: string;
    };

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

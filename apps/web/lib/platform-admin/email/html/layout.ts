/**
 * Shared HTML email layout for all ReBattery transactional emails.
 *
 * Inbox-safe: table-based layout, inline styles, no external CSS dependencies.
 * Brand colors: near-black (#2A2A2A), lime yellow (#E7F346).
 */

import {
  BRAND_PRIMARY,
  BRAND_ACCENT,
  TEXT_DARK,
  TEXT_MUTED,
  BG_CANVAS,
  BG_CARD,
  BORDER_SOFT,
} from "@/lib/platform-admin/email/brand";

const LOGO_URL = "https://rebattery.io/rebattery-logo-all-black.png";

/**
 * Wrap content HTML in the standard ReBattery email shell.
 *
 * @param content  Inner HTML — use the helpers below (heading, para, cta, divider, kv)
 * @param preview  Optional preview text shown in inbox list view (max ~90 chars)
 */
export function layout(content: string, preview?: string): string {
  const previewSnippet = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preview)}&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>ReBattery</title>
</head>
<body style="margin:0;padding:0;background:${BG_CANVAS};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${previewSnippet}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG_CANVAS};padding:40px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Logo header -->
        <tr>
          <td style="padding:0 0 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <img src="${LOGO_URL}" alt="ReBattery" width="110" style="display:block;border:0;outline:none;text-decoration:none;height:auto;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background:${BG_CARD};border:1px solid ${BORDER_SOFT};border-radius:16px;padding:40px 40px 32px;">
            ${content}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:28px 0 0;text-align:center;">
            <p style="margin:0 0 6px;font-size:12px;color:${TEXT_MUTED};">
              &copy; ${new Date().getFullYear()} ReBattery &mdash; Battery trading &amp; recycling platform
            </p>
            <p style="margin:0;font-size:12px;color:${TEXT_MUTED};">
              <a href="https://rebattery.io" style="color:${TEXT_MUTED};text-decoration:underline;">rebattery.io</a>
              &nbsp;&middot;&nbsp;
              <a href="mailto:support@rebattery.io" style="color:${TEXT_MUTED};text-decoration:underline;">support@rebattery.io</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Section heading */
export function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:${TEXT_DARK};line-height:1.25;">${esc(text)}</h1>`;
}

/** Body paragraph */
export function para(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:${TEXT_MUTED};line-height:1.6;">${esc(text)}</p>`;
}

/** Primary CTA button — yellow accent, dark text */
export function cta(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td style="background:${BRAND_ACCENT};border-radius:999px;">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${BRAND_PRIMARY};text-decoration:none;border-radius:999px;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/** Horizontal rule */
export function divider(): string {
  return `<hr style="border:none;border-top:1px solid ${BORDER_SOFT};margin:24px 0;" />`;
}

/** Key-value detail row */
export function kv(label: string, value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">
  <tr>
    <td style="font-size:13px;font-weight:600;color:${TEXT_DARK};width:40%;vertical-align:top;padding-right:8px;">${esc(label)}</td>
    <td style="font-size:13px;color:${TEXT_MUTED};vertical-align:top;">${esc(value)}</td>
  </tr>
</table>`;
}

/** Accent badge pill — yellow tint */
export function badge(text: string): string {
  return `<span style="display:inline-block;padding:3px 10px;background:rgba(231,243,70,0.13);border:1px solid rgba(231,243,70,0.40);border-radius:999px;font-size:12px;font-weight:600;color:${BRAND_PRIMARY};margin-bottom:16px;">${esc(text)}</span>`;
}

/** Muted small-print note */
export function note(text: string): string {
  return `<p style="margin:16px 0 0;font-size:12px;color:${TEXT_MUTED};line-height:1.5;">${esc(text)}</p>`;
}

/** Render plain body text with newlines converted to <p> tags */
export function paraFromText(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => para(line))
    .join("");
}

/** HTML-escape a string */
export function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function alexSignature(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
  <tr>
    <td style="padding:16px 0 0;border-top:1px solid ${BORDER_SOFT};">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:middle;padding-right:14px;">
            <img src="${LOGO_URL}" alt="ReBattery" width="110" style="display:block;border:0;" />
          </td>
          <td style="vertical-align:middle;">
            <p style="margin:0 0 2px;font-size:14px;color:${TEXT_DARK};line-height:1.5;">Alex Polglase</p>
            <p style="margin:0 0 2px;font-size:13px;color:${TEXT_MUTED};line-height:1.5;">Founder</p>
            <p style="margin:0;font-size:13px;color:${TEXT_MUTED};line-height:1.5;">ReBattery</p>
            <p style="margin:6px 0 0;font-size:13px;color:${TEXT_MUTED};line-height:1.5;">
              <a href="https://rebattery.io" style="color:${TEXT_MUTED};text-decoration:none;">www.rebattery.io</a>
              &nbsp;|&nbsp;
              <a href="mailto:alex@rebattery.io" style="color:${TEXT_MUTED};text-decoration:none;">alex@rebattery.io</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

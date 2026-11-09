import { sendRawEmail, type EmailResult } from "@/lib/platform-admin/email/send";
import { FROM_SUPPORT } from "@/lib/platform-admin/email/constants";
import { esc } from "@/lib/platform-admin/email/html/layout";
import { DASHBOARD_URL } from "./contract";
import { TX_EMAIL_PREFIX, TX_EMAIL_SUFFIX } from "./email-shell";

const P = "margin:0 0 22px;font-size:15px;line-height:1.7;color:#3D3D3D;max-width:540px;";
const H1 = "margin:0 0 14px;font-size:24px;line-height:1.15;font-weight:800;color:#0A0A0A;";
const ROW = "padding:0 0 8px;font-size:14px;line-height:1.6;color:#3D3D3D;";

function wrap(content: string): string {
  return TX_EMAIL_PREFIX + content + TX_EMAIL_SUFFIX;
}

export type RefundIssuedModel = {
  firstName: string;
  listingTitle: string;
  tagNumber: string | null;
  amount: string;
};

/** Same copy and layout as the `refund-issued` rebattery-mail template (v3). */
export function buildRefundIssuedEmail(model: RefundIssuedModel): { subject: string; html: string; text: string } {
  const rows = [
    ["Item", model.listingTitle],
    ...(model.tagNumber ? [["Tag number", model.tagNumber]] : []),
    ["Amount refunded", model.amount],
    ["Refunded to", "the card you paid with"],
  ];
  const bullets = rows
    .map(([label, value]) => `<tr><td style="${ROW}">&bull;&nbsp;<strong>${esc(label)}:</strong> ${esc(value)}</td></tr>`)
    .join("");
  const html = wrap(
    `<h1 style="${H1}">Your refund is on the way!</h1>` +
      `<p style="${P}">Hi ${esc(model.firstName)},</p>` +
      `<p style="${P}">We've issued a refund for your transaction on ${esc(model.listingTitle)} in the amount of ${esc(model.amount)} to the card you paid with.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;border:1px solid #E0E0E0;background:#FAFAFA;"><tr><td style="padding:16px 18px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bullets}</table></td></tr></table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td><a href="${DASHBOARD_URL}" target="_blank" style="display:block;background:#E7F346;color:#0A0A0A;text-decoration:none;border-radius:0;padding:13px 20px;font-size:14px;font-weight:800;text-align:center;">View your dashboard</a></td></tr></table>`,
  );
  const text = [
    "Your refund is on the way!",
    "",
    `Hi ${model.firstName},`,
    "",
    `We've issued a refund for your transaction on ${model.listingTitle} in the amount of ${model.amount} to the card you paid with.`,
    "",
    ...rows.map(([label, value]) => `- ${label}: ${value}`),
    "",
    `View your dashboard: ${DASHBOARD_URL}`,
  ].join("\n");
  return { subject: "Your refund is on the way!", html, text };
}

export type SellerCancelledModel = {
  firstName: string;
  number: string;
  listingTitle: string;
};

export function buildSellerCancelledEmail(model: SellerCancelledModel): { subject: string; html: string; text: string } {
  const subject = `Transaction #${model.number} has been cancelled`;
  const html = wrap(
    `<h1 style="${H1}">${esc(subject)}</h1>` +
      `<p style="${P}">Hi ${esc(model.firstName)},</p>` +
      `<p style="${P}">Transaction #${esc(model.number)} for ${esc(model.listingTitle)} has been cancelled.</p>`,
  );
  const text = [
    subject,
    "",
    `Hi ${model.firstName},`,
    "",
    `Transaction #${model.number} for ${model.listingTitle} has been cancelled.`,
  ].join("\n");
  return { subject, html, text };
}

export function sendRefundIssuedEmail(to: string, model: RefundIssuedModel): Promise<EmailResult> {
  const mail = buildRefundIssuedEmail(model);
  return sendRawEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, from: FROM_SUPPORT, tag: "refund-issued" });
}

export function sendSellerCancelledEmail(to: string, model: SellerCancelledModel): Promise<EmailResult> {
  const mail = buildSellerCancelledEmail(model);
  return sendRawEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, from: FROM_SUPPORT, tag: "deal-cancelled-seller" });
}

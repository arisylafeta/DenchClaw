import { FROM_SUPPLY } from "@/lib/platform-admin/email/constants";
import { layout, heading, cta, divider, badge, kv, note, esc } from "@/lib/platform-admin/email/html/layout";
import { sendRawEmail, type EmailResult } from "@/lib/platform-admin/email/send";

export interface RecyclerOpportunityInvitationModel {
  recipient_name: string;
  listing_title: string;
  units: number;
  manufacturer: string;
  model: string;
  unit_format: string;
  chemistry: string;
  total_weight_kg: string;
  application: string;
  country: string;
  listing_url: string;
}

function buildHtml(model: RecyclerOpportunityInvitationModel): string {
  const headingText = `${model.units} x ${model.manufacturer} ${model.model} ${model.unit_format}`;

  const content =
    badge("Request for quote") +
    heading(headingText) +
    `<p style="margin:0 0 16px;font-size:15px;color:#6B6B6B;line-height:1.6;">${esc(model.chemistry)} &mdash; ${esc(model.total_weight_kg)}kg &mdash; ${esc(model.country)}<br/>Previous application: ${esc(model.application)}</p>` +
    divider() +
    kv("Brand", model.manufacturer) +
    kv("Model", model.model) +
    kv("Chemistry", model.chemistry) +
    kv("Total weight", `${model.total_weight_kg}kg`) +
    kv("Previous application", model.application) +
    kv("Country", model.country) +
    divider() +
    cta("Submit quote", model.listing_url) +
    note(
      "You received this email because you were invited to quote on a ReBattery recycler opportunity. If this was unexpected, you can safely ignore it. For help, contact support@rebattery.io.",
    );

  return layout(
    content,
    `ReBattery request for quote: ${model.units}x ${model.manufacturer} ${model.model} ${model.unit_format}.`,
  );
}

export async function sendRecyclerOpportunityInvitationEmail(
  recipientEmail: string,
  model: RecyclerOpportunityInvitationModel,
): Promise<EmailResult> {
  return sendRawEmail({
    to: recipientEmail,
    subject: `Request for quote: ${model.listing_title}`,
    html: buildHtml(model),
    from: FROM_SUPPLY,
    tag: "recycler-opportunity-invitation",
  });
}

import { sendRawEmail, type EmailResult } from "@/lib/platform-admin/email/send";
import { FROM_HELLO } from "@/lib/platform-admin/email/constants";
import { layout, heading, para, cta, divider, badge, esc, alexSignature } from "@/lib/platform-admin/email/html/layout";
import { TEXT_MUTED, BRAND_ACCENT } from "@/lib/platform-admin/email/brand";

export interface AccountApprovedModel {
  recipient_name: string;
  role: "buyer" | "supplier" | "recycler";
  platform_url: string;
}

const ROLE_CONFIG: Record<
  AccountApprovedModel["role"],
  { label: string; steps: string[] }
> = {
  buyer: {
    label: "buyer",
    steps: [
      "Browse verified battery listings from trusted suppliers",
      "Submit offers or buy now at fixed price",
      "Manage agreements and payments in your deal workspace",
    ],
  },
  supplier: {
    label: "supplier",
    steps: [
      "Create listings for your available battery stock",
      "Receive and respond to purchase offers",
      "Complete deals and receive payment through the platform",
    ],
  },
  recycler: {
    label: "recycler",
    steps: [
      "Browse recycling opportunities matched to your capabilities",
      "Respond to enquiries from suppliers and buyers",
      "Build your recycler profile and grow your pipeline",
    ],
  },
};

function stepsList(steps: string[]): string {
  const items = steps
    .map(
      (step) =>
        `<tr>
          <td style="padding:0 0 12px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;width:20px;height:20px;background:rgba(231,243,70,0.13);border-radius:50%;text-align:center;line-height:20px;font-size:11px;font-weight:700;color:${BRAND_ACCENT};">&#10003;</span>
          </td>
          <td style="padding:0 0 12px 8px;font-size:14px;color:${TEXT_MUTED};line-height:1.5;vertical-align:top;">${esc(step)}</td>
        </tr>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">${items}</table>`;
}

function buildHtml(model: AccountApprovedModel): string {
  const { label, steps } = ROLE_CONFIG[model.role];
  const firstName = model.recipient_name.trim().split(/\s+/)[0] ?? model.recipient_name;

  const content =
    badge("Account approved") +
    heading(`You're in, ${firstName}.`) +
    para(`Your ${label} account has been reviewed and approved. Here's what you can do now:`) +
    stepsList(steps) +
    divider() +
    cta("Go to platform", model.platform_url) +
    alexSignature();

  return layout(content, `You're approved — your ReBattery ${label} account is ready.`);
}

export async function sendAccountApprovedEmail(
  recipientEmail: string,
  model: AccountApprovedModel,
): Promise<EmailResult> {
  return sendRawEmail({
    to: recipientEmail,
    subject: `You're approved — welcome to ReBattery`,
    html: buildHtml(model),
    from: FROM_HELLO,
    tag: `account-approved-${model.role}`,
  });
}

import { sendRawEmail, type EmailResult } from "@/lib/platform-admin/email/send";
import { FROM_SUPPORT } from "@/lib/platform-admin/email/constants";
import { layout, heading, paraFromText, alexSignature } from "@/lib/platform-admin/email/html/layout";

export interface AdminMessageModel {
  recipient_name: string;
  subject: string;
  body: string;
}

function buildHtml(model: AdminMessageModel): string {
  return layout(
    heading(model.subject) +
      paraFromText(model.body) +
      alexSignature(),
    model.subject,
  );
}

export async function sendAdminMessageEmail(
  recipientEmail: string,
  model: AdminMessageModel,
): Promise<EmailResult> {
  return sendRawEmail({
    to: recipientEmail,
    subject: model.subject,
    html: buildHtml(model),
    from: FROM_SUPPORT,
    tag: "admin-message",
  });
}

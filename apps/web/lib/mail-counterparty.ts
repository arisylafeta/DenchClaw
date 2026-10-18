import type { MailMessageRow } from "./mail-types";

/** The server resolves configured identities and CRM names; old payloads retain address-only display. */
export function mailCounterparty(message: Pick<MailMessageRow, "is_self" | "counterparty" | "from_email" | "to_emails" | "recipient_email" | "cc_emails">) {
  if (!message.is_self) {
    return { email: message.from_email, name: message.from_email ? message.counterparty?.name ?? message.from_email : "Unknown sender" };
  }
  if (message.counterparty) {return message.counterparty;}
  const recipients = [...message.to_emails, message.recipient_email, ...message.cc_emails].filter((email): email is string => Boolean(email));
  const email = recipients.find((address) => !address.toLowerCase().endsWith("@rebattery.io")) ?? recipients[0] ?? null;
  return { email, name: email ?? "Unknown recipient" };
}

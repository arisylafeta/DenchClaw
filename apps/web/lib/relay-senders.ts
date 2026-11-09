/** The addresses a Relay email can go out from. All of them send through Alex's Gmail, so each must be one of its
 * "Send mail as" addresses. Relay picks alex, supply or buy for a reply; Alex can switch a draft to any of them. */
export const SENDERS = [
  { key: "alex", address: "alex@rebattery.io" },
  { key: "supply", address: "supply@rebattery.io" },
  { key: "buy", address: "buy@rebattery.io" },
  { key: "hello", address: "hello@rebattery.io" },
] as const;

export type SenderKey = (typeof SENDERS)[number]["key"];

export const isSenderKey = (value: unknown): value is SenderKey => SENDERS.some((sender) => sender.key === value);

/** Why the mail tool would not hand a draft to another sender, in plain words. Null when it has no better words. */
export function senderRefusal(refused: string, address: string): string | null {
  const words: Record<string, string> = {
    gmail_send_as_missing: `Gmail can't send as ${address} yet. Add it in Gmail under Settings, Accounts, "Send mail as", then try again.`,
    gmail_auth_unavailable: "Couldn't check Gmail's sending addresses just now. Try again in a minute.",
    identity_fixed_on_template_draft: "This email was built from a template, so its sender is fixed.",
    identity_change_requires_gmail: "Only an email that goes out through Gmail can change sender.",
    identity_mailbox_mismatch: `${address} sends from a different mailbox, so this reply can't move to it.`,
  };
  return words[refused] ?? null;
}

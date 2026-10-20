import type { WhatsappNameSource } from "@/lib/crm-postgres/whatsapp";

/** One label for a chat everywhere. Names inferred from our own greeting are marked so nobody mistakes them for a confirmed contact. */
export function whatsappChatLabel(chat: { id: string; kind: "direct" | "group"; name?: string | null; name_source?: WhatsappNameSource }) {
  const short = chat.id.slice(0, 6);
  if (chat.name) {
    const hint = chat.name_source === "greeting" ? "Name inferred from our opening greeting. Not a confirmed contact."
      : chat.name_source === "phone" ? "Phone number captured for this chat" : chat.name_source === "person" ? "Linked CRM person" : undefined;
    return { text: chat.name, inferred: chat.name_source === "greeting", hint };
  }
  return { text: chat.kind === "group" ? `Group ${short}` : `Contact ${short}`, inferred: false, hint: "No name or number was captured for this chat" };
}

export function initialsOf(label: string) {
  const parts = label.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
}

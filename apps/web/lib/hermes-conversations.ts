// Client-safe identities. Profile filters never participate in routing a selected chat.
export type HermesParticipant = { profile: string; memberId?: string; name: string; handle?: string };
export type HermesConversation = {
  key: string;
  kind: "solo" | "group";
  id: string;
  profile?: string;
  title: string;
  updatedAt: number;
  participants: HermesParticipant[];
  working: boolean | null;
  /** Group needs attention in Hermes (approval, retry or cancellation). */
  blocked?: boolean;
};
export type HermesMessage = { id: string; role: string; text: string; content?: string; parts?: Record<string, unknown>[]; profile?: string; name?: string };
export function conversationKey(kind: "solo" | "group", id: string, profile = ""): string {
  return encodeURIComponent(JSON.stringify([kind, profile, id]));
}
export function parseConversationKey(key: string): { kind: "solo" | "group"; profile: string; id: string } {
  const value: unknown = JSON.parse(decodeURIComponent(key));
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === "string") ||
      !["solo", "group"].includes(value[0]) || !value[2] || (value[0] === "solo" && !value[1])) {
    throw new Error("Invalid conversation identity");
  }
  return { kind: value[0] as "solo" | "group", profile: value[1], id: value[2] };
}
export function filterConversations(rows: HermesConversation[], profile: string | null) {
  return profile ? rows.filter((row) => row.participants.some((p) => p.profile === profile)) : rows;
}

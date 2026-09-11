"use server";

import { unstable_noStore as noStore } from "next/cache";
import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import type { Database } from "@/lib/platform-admin/database.types";

type InquiryRow = Pick<
  Database["public"]["Tables"]["battery_requests"]["Row"],
  "id" | "session_id" | "contact_email" | "created_at"
>;

type MessageRow = Pick<
  Database["public"]["Tables"]["jules_messages"]["Row"],
  "id" | "sequence" | "role" | "body" | "created_at"
>;

export type BatteryInquiryChatMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
};

export type BatteryInquiryChat = {
  inquiryId: string;
  contactEmail: string;
  createdAt: string;
  messages: BatteryInquiryChatMessage[];
};

const INQUIRY_COLUMNS = "id, session_id, contact_email, created_at";
const MESSAGE_COLUMNS = "id, sequence, role, body, created_at";
// A Joules inquiry permits at most 40 visitor turns, with one assistant reply
// per turn plus the opening greeting. This leaves headroom without an unbounded read.
const MAX_CHAT_MESSAGES = 100;

export async function getBatteryInquiryChat(
  inquiryId: string,
): Promise<BatteryInquiryChat | null> {
  noStore();
  const user = await currentUser();
  if (!user || !ALLOWED_EMAILS.has(user.email)) {
    throw new Error("Unauthorized");
  }

  const supabase = getSupabaseAdminClient();
  const inquiryResponse = await supabase
    .from("battery_requests")
    .select(INQUIRY_COLUMNS)
    .eq("id", inquiryId)
    .maybeSingle();
  if (inquiryResponse.error) {
    throw new Error("Unable to load inquiry chat");
  }
  if (!inquiryResponse.data) {
    return null;
  }

  const inquiry = inquiryResponse.data as InquiryRow;
  const messageResponse = await supabase
    .from("jules_messages")
    .select(MESSAGE_COLUMNS)
    .eq("session_id", inquiry.session_id)
    .in("role", ["user", "assistant"])
    .order("sequence", { ascending: true })
    .limit(MAX_CHAT_MESSAGES);
  if (messageResponse.error) {
    throw new Error("Unable to load inquiry chat");
  }

  const messages = (messageResponse.data as MessageRow[] | null ?? [])
    .filter((message): message is MessageRow & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role,
      body: message.body,
      createdAt: message.created_at,
    }))
    .toSorted((left, right) =>
      left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );

  return {
    inquiryId: inquiry.id,
    contactEmail: inquiry.contact_email,
    createdAt: inquiry.created_at,
    messages,
  };
}

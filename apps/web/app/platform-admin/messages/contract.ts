import type { Database } from "@/lib/platform-admin/database.types";

export const MESSAGE_STATUSES = ["delivered", "rejected", "pending"] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type MessageRecord = Pick<
  Database["public"]["Tables"]["conversation_messages"]["Row"],
  | "id"
  | "conversation_id"
  | "sender_membership_id"
  | "body"
  | "message_type"
  | "is_system_seeded"
  | "created_at"
  | "updated_at"
  | "moderation_status"
  | "moderation_reason_code"
  | "moderation_reason_text"
  | "moderation_policy_version"
  | "moderation_decision_source"
  | "moderation_attempt_count"
  | "moderation_failure_code"
  | "moderation_decided_at"
  | "attachment_file_name"
  | "attachment_content_type"
  | "attachment_size_bytes"
>;

export type MessageFilters = {
  search: string;
  from: string;
  to: string;
  status: MessageStatus | "";
};

export type MessagePageInput = Partial<MessageFilters> & { page?: number };

export type MessageListRow = MessageRecord & {
  sender: {
    membershipId: string;
    accountId: string | null;
    displayName: string;
    email: string | null;
    role: string | null;
  } | null;
  conversation: {
    id: string;
    type: string;
    status: string;
    supplierAccountId: string;
    supplierName: string | null;
    counterpartyAccountId: string;
    counterpartyName: string | null;
  } | null;
  listing: {
    id: string;
    title: string | null;
    reference: string | null;
    slug: string | null;
  } | null;
};

export type MessagePage = {
  rows: MessageListRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: MessageFilters;
};

export type MessageDetail = {
  message: MessageListRow;
  context: MessageListRow[];
};

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanSearchText(value: unknown, maxLength = 100): string {
  return cleanText(value, maxLength).replace(/[(),*%_"'\\]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanDate(value: unknown): string {
  const date = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function cleanEnum<T extends readonly string[]>(value: unknown, allowed: T): T[number] | "" {
  const candidate = cleanText(value, 60);
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T[number]) : "";
}

export function normalizeMessageFilters(input: MessagePageInput = {}): MessageFilters {
  return {
    search: cleanSearchText(input.search),
    from: cleanDate(input.from),
    to: cleanDate(input.to),
    status: cleanEnum(input.status, MESSAGE_STATUSES),
  };
}

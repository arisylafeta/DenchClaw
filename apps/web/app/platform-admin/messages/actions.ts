"use server";

import { unstable_noStore as noStore } from "next/cache";

import type { Database } from "@/lib/platform-admin/database.types";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  normalizeMessageFilters,
  type MessageDetail,
  type MessageFilters,
  type MessageListRow,
  type MessagePage,
  type MessagePageInput,
  type MessageRecord,
} from "./contract";

const PAGE_SIZE = 25;
const MAX_PAGE = 10_000;
const MAX_FILTER_MATCHES = 200;
const MAX_CONTEXT_MESSAGES = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

type MessageDbRow = MessageRecord;
type ConversationDbRow = Database["public"]["Tables"]["conversations"]["Row"];
type AccountDbRow = Pick<Database["public"]["Tables"]["accounts"]["Row"], "id" | "name">;
type ListingDbRow = Pick<
  Database["public"]["Tables"]["listings"]["Row"],
  "id" | "title" | "reference" | "seo_slug"
>;
type MembershipDbRow = Pick<
  Database["public"]["Tables"]["account_memberships"]["Row"],
  "id" | "account_id" | "user_id" | "membership_role"
>;
type UserDbRow = Pick<
  Database["public"]["Tables"]["users"]["Row"],
  "id" | "email" | "full_name"
>;

type ReadResult<T> = {
  data: unknown;
  error: { message: string } | null;
};

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanSearchText(value: unknown, maxLength = 100): string {
  return cleanText(value, maxLength).replace(/[(),*%_"'\\]/g, " ").replace(/\s+/g, " ").trim();
}

function safePage(value: unknown): number {
  const page = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(page)) return 1;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(page)));
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function throwReadError(): never {
  // Do not forward database errors to the operator or server logs: message
  // reads must never turn sensitive row context into diagnostic telemetry.
  throw new Error("Unable to load marketplace message monitoring data");
}

async function readRows<T>(result: PromiseLike<ReadResult<T>>): Promise<T[]> {
  const response = await result;
  if (response.error) throwReadError();
  return Array.isArray(response.data) ? response.data as T[] : [];
}

async function readOne<T>(
  result: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T | null> {
  const response = await result;
  if (response.error) throwReadError();
  return response.data ? response.data as T : null;
}

function filterDateBoundary(value: string, end: boolean): string | null {
  if (!value) return null;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type GlobalSearchMatches = {
  conversationIds: string[];
  senderMembershipIds: string[];
};

function uniqueIds(rows: Array<{ id: string }>): string[] {
  return [...new Set(rows.map((row) => row.id))].slice(0, MAX_FILTER_MATCHES);
}

async function resolveGlobalSearchMatches(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  value: string,
): Promise<GlobalSearchMatches> {
  const search = cleanSearchText(value);
  if (!search) return { conversationIds: [], senderMembershipIds: [] };
  const pattern = `%${search}%`;

  const [accountNameRows, listingTitleRows, listingReferenceRows, listingSlugRows, userEmailRows, userNameRows] = await Promise.all([
    readRows<{ id: string }>(supabase.from("accounts").select("id").ilike("name", pattern).limit(MAX_FILTER_MATCHES)),
    readRows<{ id: string }>(supabase.from("listings").select("id").ilike("title", pattern).limit(MAX_FILTER_MATCHES)),
    readRows<{ id: string }>(supabase.from("listings").select("id").ilike("reference", pattern).limit(MAX_FILTER_MATCHES)),
    readRows<{ id: string }>(supabase.from("listings").select("id").ilike("seo_slug", pattern).limit(MAX_FILTER_MATCHES)),
    readRows<{ id: string }>(supabase.from("users").select("id").ilike("email", pattern).limit(MAX_FILTER_MATCHES)),
    readRows<{ id: string }>(supabase.from("users").select("id").ilike("full_name", pattern).limit(MAX_FILTER_MATCHES)),
  ]);

  const [directAccountRows, directListingRows, directUserRows] = isUuid(search)
    ? await Promise.all([
        readRows<{ id: string }>(supabase.from("accounts").select("id").eq("id", search).limit(1)),
        readRows<{ id: string }>(supabase.from("listings").select("id").eq("id", search).limit(1)),
        readRows<{ id: string }>(supabase.from("users").select("id").eq("id", search).limit(1)),
      ])
    : [[], [], []] as const;
  const accountIds = uniqueIds([...accountNameRows, ...directAccountRows]);
  const listingIds = uniqueIds([...listingTitleRows, ...listingReferenceRows, ...listingSlugRows, ...directListingRows]);
  const userIds = uniqueIds([...userEmailRows, ...userNameRows, ...directUserRows]);
  const directConversationRows = isUuid(search)
    ? await readRows<{ id: string }>(supabase.from("conversations").select("id").eq("id", search).limit(1))
    : [];
  const relatedConversationRows = await Promise.all([
    accountIds.length > 0
      ? readRows<{ id: string }>(
          supabase
            .from("conversations")
            .select("id")
            .or(`supplier_account_id.in.(${accountIds.join(",")}),counterparty_account_id.in.(${accountIds.join(",")})`)
            .limit(MAX_FILTER_MATCHES),
        )
      : Promise.resolve([] as { id: string }[]),
    listingIds.length > 0
      ? readRows<{ id: string }>(
          supabase.from("conversations").select("id").in("listing_id", listingIds).limit(MAX_FILTER_MATCHES),
        )
      : Promise.resolve([] as { id: string }[]),
  ]);

  const directMembershipRows = isUuid(search)
    ? await readRows<{ id: string }>(supabase.from("account_memberships").select("id").eq("id", search).limit(1))
    : [];
  const userMembershipRows = userIds.length > 0
    ? await readRows<{ id: string }>(
        supabase.from("account_memberships").select("id").in("user_id", userIds).limit(MAX_FILTER_MATCHES),
      )
    : [];

  return {
    conversationIds: uniqueIds([...directConversationRows, ...relatedConversationRows[0], ...relatedConversationRows[1]]),
    senderMembershipIds: uniqueIds([...directMembershipRows, ...userMembershipRows]),
  };
}

async function hydrateMessages(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  messages: MessageDbRow[],
  providedConversations: ConversationDbRow[] = [],
): Promise<MessageListRow[]> {
  const conversationIds = [...new Set(messages.map((message) => message.conversation_id))];
  const membershipIds = [...new Set(messages.map((message) => message.sender_membership_id).filter(Boolean))] as string[];
  const conversations = providedConversations.length > 0
    ? providedConversations
    : await readRows<ConversationDbRow>(supabase.from("conversations").select("*").in("id", conversationIds));
  const accountIds = [...new Set(conversations.flatMap((conversation) => [
    conversation.supplier_account_id,
    conversation.counterparty_account_id,
  ]))];

  const [accounts, listings, memberships] = await Promise.all([
    accountIds.length > 0
      ? readRows<AccountDbRow>(supabase.from("accounts").select("id, name").in("id", accountIds))
      : Promise.resolve([] as AccountDbRow[]),
    conversations.length > 0
      ? readRows<ListingDbRow>(supabase.from("listings").select("id, title, reference, seo_slug").in("id", [...new Set(conversations.map((conversation) => conversation.listing_id))]))
      : Promise.resolve([] as ListingDbRow[]),
    membershipIds.length > 0
      ? readRows<MembershipDbRow>(supabase.from("account_memberships").select("id, account_id, user_id, membership_role").in("id", membershipIds))
      : Promise.resolve([] as MembershipDbRow[]),
  ]);

  const users = memberships.length > 0
    ? await readRows<UserDbRow>(supabase.from("users").select("id, email, full_name").in("id", memberships.map((membership) => membership.user_id)))
    : [];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]));
  const userById = new Map(users.map((user) => [user.id, user]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));

  return messages.map((message) => {
    const conversation = conversationById.get(message.conversation_id) ?? null;
    const membership = message.sender_membership_id
      ? membershipById.get(message.sender_membership_id) ?? null
      : null;
    const user = membership ? userById.get(membership.user_id) : null;
    return {
      ...message,
      sender: membership
        ? {
            membershipId: membership.id,
            accountId: membership.account_id,
            displayName: user?.full_name || user?.email || "Unknown sender",
            email: user?.email ?? null,
            role: membership.membership_role,
          }
        : null,
      conversation: conversation
        ? {
            id: conversation.id,
            type: conversation.conversation_type,
            status: conversation.status,
            supplierAccountId: conversation.supplier_account_id,
            supplierName: accountById.get(conversation.supplier_account_id)?.name ?? null,
            counterpartyAccountId: conversation.counterparty_account_id,
            counterpartyName: accountById.get(conversation.counterparty_account_id)?.name ?? null,
          }
        : null,
      listing: conversation
        ? (() => {
            const listing = listingById.get(conversation.listing_id);
            return listing
              ? { id: listing.id, title: listing.title, reference: listing.reference, slug: listing.seo_slug }
              : null;
          })()
        : null,
    };
  });
}

const MESSAGE_COLUMNS = [
  "id",
  "conversation_id",
  "sender_membership_id",
  "body",
  "message_type",
  "is_system_seeded",
  "created_at",
  "updated_at",
  "moderation_status",
  "moderation_reason_code",
  "moderation_reason_text",
  "moderation_policy_version",
  "moderation_decision_source",
  "moderation_attempt_count",
  "moderation_failure_code",
  "moderation_decided_at",
  "attachment_file_name",
  "attachment_content_type",
  "attachment_size_bytes",
].join(", ");

const MESSAGE_ORDER = [
  ["created_at", { ascending: false }],
  ["id", { ascending: false }],
] as const;

export async function getMessagePage(input: MessagePageInput = {}): Promise<MessagePage> {
  noStore();
  const filters = normalizeMessageFilters(input);
  const page = safePage(input.page);
  const supabase = getSupabaseAdminClient();
  const searchMatches = await resolveGlobalSearchMatches(supabase, filters.search);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("conversation_messages")
    .select(MESSAGE_COLUMNS, { count: "exact" });
  for (const [column, options] of MESSAGE_ORDER) query = query.order(column, options);
  query = query.range(offset, offset + PAGE_SIZE - 1);
  if (filters.search) {
    const searchParts = [`body.ilike.%${filters.search}%`];
    if (searchMatches.conversationIds.length > 0) {
      searchParts.push(`conversation_id.in.(${searchMatches.conversationIds.join(",")})`);
    }
    if (searchMatches.senderMembershipIds.length > 0) {
      searchParts.push(`sender_membership_id.in.(${searchMatches.senderMembershipIds.join(",")})`);
    }
    query = query.or(searchParts.join(","));
  }
  if (filters.from) query = query.gte("created_at", filterDateBoundary(filters.from, false) ?? filters.from);
  if (filters.to) query = query.lte("created_at", filterDateBoundary(filters.to, true) ?? filters.to);
  if (filters.status) query = query.eq("moderation_status", filters.status);

  const response = await query;
  if (response.error) throwReadError();
  const rawRows = (response.data ?? []) as unknown as MessageDbRow[];
  const totalCount = response.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  return {
    rows: await hydrateMessages(supabase, rawRows),
    totalCount,
    page: currentPage,
    pageSize: PAGE_SIZE,
    totalPages,
    filters,
  };
}

export async function getMessageDetail(messageId: string): Promise<MessageDetail | null> {
  noStore();
  const id = cleanText(messageId, 80);
  if (!id) return null;
  const supabase = getSupabaseAdminClient();
  const message = await readOne<MessageDbRow>(
    supabase.from("conversation_messages").select(MESSAGE_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!message) return null;
  const conversation = await readOne<ConversationDbRow>(
    supabase.from("conversations").select("*").eq("id", message.conversation_id).maybeSingle(),
  );
  if (!conversation) {
    const [hydrated] = await hydrateMessages(supabase, [message]);
    return hydrated ? { message: hydrated, context: [] } : null;
  }
  const contextLimit = Math.ceil(MAX_CONTEXT_MESSAGES / 2);
  const [beforeRows, afterRows] = await Promise.all([
    readRows<MessageDbRow>(
      supabase
        .from("conversation_messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", conversation.id)
        .lte("created_at", message.created_at)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(contextLimit),
    ),
    readRows<MessageDbRow>(
      supabase
        .from("conversation_messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", conversation.id)
        .gte("created_at", message.created_at)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(contextLimit),
    ),
  ]);
  const contextRows = [...new Map(
    [...beforeRows, ...afterRows].map((row) => [row.id, row]),
  ).values()].sort((left, right) => {
    const created = left.created_at.localeCompare(right.created_at);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
  const context = await hydrateMessages(supabase, contextRows, [conversation]);
  const hydratedMessage = context.find((row) => row.id === message.id)
    ?? (await hydrateMessages(supabase, [message], [conversation]))[0];
  return hydratedMessage ? { message: hydratedMessage, context } : null;
}

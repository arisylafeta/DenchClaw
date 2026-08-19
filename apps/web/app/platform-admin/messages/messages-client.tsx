"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, Loader2, Paperclip, Search, X } from "lucide-react";

import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/platform-admin/ui/card";
import { Input } from "@/app/components/platform-admin/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/platform-admin/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/platform-admin/ui/table";
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
import { getMessageDetail } from "./actions";
import {
  MESSAGE_STATUSES,
  type MessageDetail,
  type MessageFilters,
  type MessageListRow,
  type MessagePage,
} from "./contract";

type MessagesClientProps = { initialPage: MessagePage };

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function shortId(value: string | null | undefined): string {
  return value ? `${value.slice(0, 8)}…` : "—";
}

function senderInitials(row: MessageListRow): string {
  const name = row.sender?.displayName?.trim() || "Unknown sender";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || "?";
}

function sizeLabel(bytes: number | null): string | null {
  if (!bytes || bytes < 1) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ row }: { row: MessageListRow }) {
  const status = row.moderation_status || "unknown";
  const source = row.moderation_decision_source;
  const failure = row.moderation_failure_code;
  const className = status === "delivered"
    ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "rejected"
      ? "border-red-300/50 bg-red-500/10 text-red-700 dark:text-red-300"
      : status === "pending"
        ? "border-amber-300/50 bg-amber-500/10 text-amber-800 dark:text-amber-200"
        : "border-[var(--color-border)] text-[var(--color-text-muted)]";
  return (
    <div className="flex min-w-[9.5rem] flex-wrap gap-1">
      <Badge variant="outline" className={className}>{status}</Badge>
      {source && <Badge variant="secondary">{source === "fail_open" ? "fail-open" : source === "model" ? "model-reviewed" : source}</Badge>}
      {failure && <Badge variant="destructive" className="max-w-full">{failure}</Badge>}
    </div>
  );
}

function MessagePreview({ row }: { row: MessageListRow }) {
  const body = row.body?.trim() || "(empty body)";
  const attachment = row.attachment_file_name;
  return (
    <div className="min-w-[16rem] max-w-[34rem] whitespace-normal">
      <p className="line-clamp-2 break-words text-sm text-[var(--color-text)]">{body}</p>
      {attachment && (
        <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <Paperclip className="size-3" aria-hidden />
          <span className="truncate">{attachment}</span>
          {sizeLabel(row.attachment_size_bytes) && <span>· {sizeLabel(row.attachment_size_bytes)}</span>}
        </p>
      )}
    </div>
  );
}

function conversationLabel(row: MessageListRow): string {
  if (!row.conversation) return "Conversation unavailable";
  return `${row.conversation.supplierName ?? "Unknown supplier"} ↔ ${row.conversation.counterpartyName ?? "Unknown counterparty"}`;
}

function buildQuery(filters: MessageFilters, page: number): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  const values: Record<string, string> = {
    search: filters.search,
    from: filters.from,
    to: filters.to,
    status: filters.status,
  };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params.toString();
}

function FilterSelect({
  ariaLabel,
  value,
  placeholder,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  placeholder: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value || "all"} onValueChange={(next: string) => onChange(next === "all" ? "" : next)}>
      <SelectTrigger aria-label={ariaLabel} className="w-full sm:w-[10.5rem]"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {options.map((option) => <SelectItem key={option} value={option}>{option.replaceAll("_", " ")}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function MessagesClient({ initialPage }: MessagesClientProps) {
  const router = useRouter();
  const [filters, setFilters] = useState<MessageFilters>(initialPage.filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => setFilters(initialPage.filters), [initialPage.filters]);

  const navigate = (nextFilters: MessageFilters, page = 1) => {
    startTransition(() => router.replace(`/platform-admin/messages?${buildQuery(nextFilters, page)}`));
  };

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailPending(true);
    try {
      const data = await getMessageDetail(id);
      if (!data) setDetailError("This message or its conversation is no longer available.");
      else setDetail(data);
    } catch {
      setDetailError("The protected message detail could not be loaded.");
    } finally {
      setDetailPending(false);
    }
  };

  return (
    <main className="min-h-full bg-[var(--color-bg)] p-4 sm:p-6">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">Dench admin</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-text)]">Message monitoring</h1>
            <p className="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">Read-only delivery and moderation visibility for marketplace conversations. Message content stays inside this protected admin view.</p>
          </div>
          <Badge variant="outline" className="self-start border-[var(--color-border)] sm:self-auto">Newest first · {initialPage.totalCount.toLocaleString()} matched</Badge>
        </header>

        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Search and filters</CardTitle>
            <CardDescription>Search spans message text, conversation IDs, account names, listings, and sender names or email. All filters run on the server.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
              onSubmit={(event) => { event.preventDefault(); navigate(filters); }}
            >
              <label className="md:col-span-2 xl:col-span-4">
                <span className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">Search all message context</span>
                <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden /><Input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Search message text, sender, account, listing, or conversation..." className="pl-9" /></div>
              </label>
              <label><span className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">From date</span><Input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
              <label><span className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">To date</span><Input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
              <FilterSelect ariaLabel="Filter by moderation status" value={filters.status} placeholder="All statuses" options={MESSAGE_STATUSES} onChange={(status) => setFilters({ ...filters, status: status as MessageFilters["status"] })} />
              <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
                <Button type="submit" disabled={isPending}><Search className="size-4" aria-hidden />Apply filters</Button>
                <Button type="button" variant="ghost" onClick={() => { const empty = { search: "", from: "", to: "", status: "" } satisfies MessageFilters; setFilters(empty); navigate(empty); }}>Reset</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="border-b border-[var(--color-border)] pb-4">
            <div className="flex items-center justify-between gap-3"><div><CardTitle className="text-base">Marketplace messages</CardTitle><CardDescription className="mt-1">Newest activity first. Select a message to inspect its protected thread context.</CardDescription></div>{isPending && <Loader2 className="size-4 animate-spin text-[var(--color-text-muted)]" aria-label="Loading messages" />}</div>
          </CardHeader>
          <CardContent className="p-0">
            {initialPage.rows.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center"><Search className="size-7 text-[var(--color-text-muted)]" aria-hidden /><p className="font-medium text-[var(--color-text)]">No messages match these filters</p><p className="text-sm text-[var(--color-text-muted)]">Try widening the date range or clearing a filter.</p></div>
            ) : (
              <Table className="min-w-[960px]">
                <TableHeader><TableRow><TableHead className="w-[17rem]">Sender</TableHead><TableHead className="w-[12rem]">Created</TableHead><TableHead className="w-[18rem]">Conversation / listing</TableHead><TableHead>Message</TableHead><TableHead className="w-[13rem]">Moderation</TableHead><TableHead className="w-8" /></TableRow></TableHeader>
                <TableBody>
                  {initialPage.rows.map((row) => (
                    <TableRow key={row.id} className="cursor-pointer [&>td]:py-3" onClick={() => void openDetail(row.id)}>
                      <TableCell>
                        <div className="flex min-w-52 items-center gap-2.5 whitespace-normal">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[11px] font-semibold text-[var(--color-accent)]" aria-hidden>{senderInitials(row)}</span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-[var(--color-text)]">{row.sender?.displayName ?? "Unknown sender"}</p>
                            <p className="truncate text-xs text-[var(--color-text-muted)]">{row.sender?.email ?? "Membership unavailable"}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><span className="text-xs text-[var(--color-text-muted)]">{dateTime(row.created_at)}</span></TableCell>
                      <TableCell><div className="max-w-56 whitespace-normal"><p className="text-sm text-[var(--color-text)]">{conversationLabel(row)}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{row.listing?.title ?? "Listing context unavailable"}{row.listing?.reference ? ` · ${row.listing.reference}` : ""}</p></div></TableCell>
                      <TableCell><MessagePreview row={row} /></TableCell>
                      <TableCell><StatusBadge row={row} /><p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{row.moderation_reason_code ?? (row.moderation_attempt_count ? `${row.moderation_attempt_count} attempt${row.moderation_attempt_count === 1 ? "" : "s"}` : "No decision metadata")}</p></TableCell>
                      <TableCell><ChevronRight className="size-4 text-[var(--color-text-muted)]" aria-hidden /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          <div className="border-t border-[var(--color-border)] px-5 py-3"><TablePagination page={initialPage.page} pageSize={initialPage.pageSize} totalCount={initialPage.totalCount} totalPages={initialPage.totalPages} itemLabel="message" onPageChange={(page) => navigate(filters, page)} /></div>
        </Card>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
          <section role="dialog" aria-modal="true" aria-label="Message detail" className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Protected detail</p><h2 className="mt-1 text-lg font-semibold text-[var(--color-text)]">Message {shortId(selectedId)}</h2></div><Button type="button" variant="ghost" size="icon" aria-label="Close message detail" onClick={() => setSelectedId(null)}><X className="size-4" aria-hidden /></Button></div>
            <div className="overflow-y-auto p-5">
              {detailPending && <div className="flex min-h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-[var(--color-text-muted)]" aria-label="Loading message detail" /></div>}
              {detailError && <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center"><AlertTriangle className="size-6 text-amber-600" aria-hidden /><p className="font-medium text-[var(--color-text)]">{detailError}</p></div>}
              {detail && <MessageDetailView detail={detail} />}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function MessageDetailView({ detail }: { detail: MessageDetail }) {
  const row = detail.message;
  const listing = row.listing;
  const listingHref = listing ? `/platform-admin/proposals?proposalListingFilter=${encodeURIComponent(listing.id)}` : null;
  const accountIds = row.conversation ? [row.conversation.supplierAccountId, row.conversation.counterpartyAccountId] : [];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Moderation</p><div className="mt-2"><StatusBadge row={row} /></div><dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><dt className="text-[var(--color-text-muted)]">Reason</dt><dd className="text-right text-[var(--color-text)]">{row.moderation_reason_code ?? "—"}</dd><dt className="text-[var(--color-text-muted)]">Policy</dt><dd className="text-right text-[var(--color-text)]">{row.moderation_policy_version ?? "—"}</dd><dt className="text-[var(--color-text-muted)]">Attempts</dt><dd className="text-right text-[var(--color-text)]">{row.moderation_attempt_count ?? "—"}</dd><dt className="text-[var(--color-text-muted)]">Decided</dt><dd className="text-right text-[var(--color-text)]">{dateTime(row.moderation_decided_at)}</dd></dl>{row.moderation_reason_text && <p className="mt-3 rounded-xl bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-muted)]">{row.moderation_reason_text}</p>}</div>
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Context</p><dl className="mt-2 space-y-2 text-sm"><div className="flex justify-between gap-4"><dt className="text-[var(--color-text-muted)]">Sender</dt><dd className="text-right text-[var(--color-text)]">{row.sender?.displayName ?? "Unknown sender"}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--color-text-muted)]">Conversation</dt><dd className="max-w-[65%] truncate text-right text-[var(--color-text)]">{row.conversation?.id ?? "Unavailable"}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--color-text-muted)]">Listing</dt><dd className="text-right">{listing ? <a className="text-[var(--color-accent)] underline-offset-2 hover:underline" href={listingHref ?? "#"}>{listing.title ?? listing.id}</a> : <span className="text-[var(--color-text-muted)]">Unavailable</span>}</dd></div><div className="flex justify-between gap-4"><dt className="text-[var(--color-text-muted)]">Accounts</dt><dd className="flex max-w-[65%] flex-wrap justify-end gap-1">{accountIds.length ? accountIds.map((id) => <a key={id} className="text-xs text-[var(--color-accent)] underline-offset-2 hover:underline" href={`/platform-admin/accounts?account=${encodeURIComponent(id)}`}>{shortId(id)}</a>) : <span className="text-[var(--color-text-muted)]">Unavailable</span>}</dd></div></dl></div>
      </div>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Full message</p><div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4 text-sm leading-6 text-[var(--color-text)]">{row.body || "(empty body)"}</div>{row.attachment_file_name && <p className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Paperclip className="size-3" aria-hidden />{row.attachment_file_name}{sizeLabel(row.attachment_size_bytes) ? ` · ${sizeLabel(row.attachment_size_bytes)}` : ""}{row.attachment_content_type ? ` · ${row.attachment_content_type}` : ""}</p>}</div>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Nearby conversation context</p><div className="mt-2 space-y-2">{detail.context.length === 0 && <p className="rounded-xl bg-[var(--color-surface-hover)] p-3 text-sm text-[var(--color-text-muted)]">No nearby messages are available.</p>}{detail.context.map((contextRow) => <div key={contextRow.id} className={`rounded-xl border p-3 ${contextRow.id === row.id ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5" : "border-[var(--color-border)]"}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-[var(--color-text)]">{contextRow.sender?.displayName ?? "Unknown sender"}</span><span className="text-[11px] text-[var(--color-text-muted)]">{dateTime(contextRow.created_at)}</span></div><p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{contextRow.body || "(empty body)"}</p><div className="mt-2"><StatusBadge row={contextRow} /></div></div>)}</div></div>
    </div>
  );
}

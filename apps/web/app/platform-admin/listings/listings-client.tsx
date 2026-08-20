"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpDown, Check, ChevronRight, Clipboard, ExternalLink, Loader2, MessageSquare, Search } from "lucide-react";

import { getListingDetails } from "./actions";
import type {
  ListingDetail,
  ListingFilters,
  ListingListRow,
  ListingOutboundContext,
  ListingPage,
} from "./contract";
import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Input } from "@/app/components/platform-admin/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/platform-admin/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/platform-admin/ui/table";
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/platform-admin/ui/sheet";

type ListingsClientProps = { initialPage: ListingPage };

const SORT_OPTIONS = [
  ["updated_desc", "Latest updated"],
  ["updated_asc", "Oldest updated"],
  ["capacity_desc", "Capacity: high → low"],
  ["capacity_asc", "Capacity: low → high"],
  ["weight_desc", "Weight: high → low"],
  ["weight_asc", "Weight: low → high"],
] as const;

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  published: { label: "Published", className: "border-green-200 bg-green-50 text-green-700" },
  draft: { label: "Draft", className: "border-gray-200 bg-gray-100 text-gray-700" },
  withdrawn: { label: "Withdrawn", className: "border-red-200 bg-red-50 text-red-700" },
  completed: { label: "Completed", className: "border-blue-200 bg-blue-50 text-blue-700" },
};

const VISIBILITY_LABELS: Record<string, string> = {
  public: "Public",
  buyer_network: "Buyer network",
};

function buildQuery(filters: ListingFilters, page: number): string {
  const params = new URLSearchParams();
  const values: Record<string, string> = {
    search: filters.search,
    minKwh: filters.minKwh,
    maxKwh: filters.maxKwh,
    minWeightKg: filters.minWeightKg,
    maxWeightKg: filters.maxWeightKg,
    status: filters.status,
    channel: filters.channel,
    sort: filters.sort === "updated_desc" ? "" : filters.sort,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) { params.set(key, value); }
  }
  if (page > 1) { params.set("page", String(page)); }
  return params.toString();
}

function formatNumber(value: number | null, suffix: string): string {
  if (value === null || !Number.isFinite(value)) { return "—"; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${suffix}`;
}

function formatQuantity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) { return "—"; }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) { return "—"; }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) { return "—"; }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) { return "Not recorded"; }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) { return "Not recorded"; }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function filterSummary(filters: ListingFilters): string {
  const parts: string[] = [];
  if (filters.search) { parts.push(`Search: “${filters.search}”`); }
  if (filters.minKwh || filters.maxKwh) { parts.push(`Capacity: ${filters.minKwh || "0"}–${filters.maxKwh || "∞"} kWh`); }
  if (filters.minWeightKg || filters.maxWeightKg) { parts.push(`Weight: ${filters.minWeightKg || "0"}–${filters.maxWeightKg || "∞"} kg`); }
  if (filters.status) { parts.push(`Status: ${filters.status}`); }
  if (filters.channel) { parts.push(`Channel: ${filters.channel}`); }
  if (filters.sort !== "updated_desc") { parts.push(`Sort: ${filters.sort.replaceAll("_", " ")}`); }
  return parts.length > 0 ? parts.join(" · ") : "All listings · Latest updated first";
}

const EMPTY_OUTBOUND: ListingOutboundContext = {
  targetStatus: null,
  currentAvailability: null,
  buyerSegments: [],
  enquiryCount: 0,
  dealCount: 0,
  offerCount: 0,
  opportunityCount: 0,
  conversationCount: 0,
  lastMarketplaceContactAt: null,
  recentOffers: [],
  opportunityLinks: [],
  conversations: [],
};

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function statusBadge(status: string | null) {
  if (!status) { return <Badge variant="outline" className="max-w-full truncate border-[var(--color-border)] text-[var(--color-text-muted)]">Unknown</Badge>; }
  const style = STATUS_STYLES[status] ?? { label: status.replaceAll("_", " "), className: "border-[var(--color-border)] text-[var(--color-text-muted)]" };
  return <Badge variant="outline" className={`max-w-full truncate ${style.className}`} title={style.label}>{style.label}</Badge>;
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
    <Select value={value || "all"} onValueChange={(next) => onChange(next === "all" ? "" : next)}>
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-[8.25rem] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>{option.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ListingsClient({ initialPage }: ListingsClientProps) {
  const router = useRouter();
  const [filters, setFilters] = useState<ListingFilters>(initialPage.filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ListingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => setFilters(initialPage.filters), [initialPage.filters]);

  const navigate = (nextFilters: ListingFilters, page = 1) => {
    const query = buildQuery(nextFilters, page);
    startTransition(() => router.replace(`/platform-admin/listings${query ? `?${query}` : ""}`));
  };

  const openDetails = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailPending(true);
    try {
      const data = await getListingDetails(id);
      if (!data) { setDetailError("This listing is no longer available."); }
      else { setDetail(data); }
    } catch {
      setDetailError("The protected listing details could not be loaded.");
    } finally {
      setDetailPending(false);
    }
  };

  const resetFilters = () => {
    const empty: ListingFilters = {
      search: "",
      minKwh: "",
      maxKwh: "",
      minWeightKg: "",
      maxWeightKg: "",
      status: "",
      channel: "",
      sort: "updated_desc",
    };
    setFilters(empty);
    navigate(empty);
  };

  const copyViewLink = async () => {
    const query = buildQuery(initialPage.filters, 1);
    const url = `${window.location.origin}/platform-admin/listings${query ? `?${query}` : ""}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      setLinkCopied(false);
    }
  };

  return (
    <main className="min-h-full bg-[var(--color-bg)] p-4 sm:p-6">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">Dench admin</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-text)]">Listings</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Find stock by capacity or weight. Select a row for the full read-only record.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <Badge variant="outline" className="border-[var(--color-border)]">{initialPage.totalCount.toLocaleString()} listings</Badge>
            <Badge variant="outline" className="border-[var(--color-border)]">Snapshot {formatDateTime(initialPage.snapshotAt)}</Badge>
          </div>
        </header>

        <section className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" aria-label="Repeatable target view">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Repeatable target view</p>
            <p className="mt-1 truncate text-sm font-medium text-[var(--color-text)]" title={filterSummary(initialPage.filters)}>{filterSummary(initialPage.filters)}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Exact filters are encoded in the URL. Snapshot taken {formatDateTime(initialPage.snapshotAt)}.</p>
          </div>
          <Button type="button" size="sm" variant="outline" className="shrink-0 text-xs" onClick={() => void copyViewLink()}>
            {linkCopied ? <Check className="size-3.5" aria-hidden /> : <Clipboard className="size-3.5" aria-hidden />}
            {linkCopied ? "View link copied" : "Copy view link"}
          </Button>
        </section>

        <form
          className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          onSubmit={(event) => { event.preventDefault(); navigate(filters); }}
        >
          <div className="relative min-w-[15rem] flex-1 basis-[18rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden />
            <Input
              aria-label="Search listings"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder="Search listing, supplier, make, model, or location"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Input aria-label="Minimum capacity in kWh" type="number" min="0" step="0.01" value={filters.minKwh} onChange={(event) => setFilters({ ...filters, minKwh: event.target.value })} placeholder="min kWh" className="h-8 w-[6.5rem] text-xs" />
          <Input aria-label="Maximum capacity in kWh" type="number" min="0" step="0.01" value={filters.maxKwh} onChange={(event) => setFilters({ ...filters, maxKwh: event.target.value })} placeholder="max kWh" className="h-8 w-[6.5rem] text-xs" />
          <Input aria-label="Minimum weight in kilograms" type="number" min="0" step="0.01" value={filters.minWeightKg} onChange={(event) => setFilters({ ...filters, minWeightKg: event.target.value })} placeholder="min kg" className="h-8 w-[6.5rem] text-xs" />
          <Input aria-label="Maximum weight in kilograms" type="number" min="0" step="0.01" value={filters.maxWeightKg} onChange={(event) => setFilters({ ...filters, maxWeightKg: event.target.value })} placeholder="max kg" className="h-8 w-[6.5rem] text-xs" />
          <FilterSelect ariaLabel="Filter by listing status" value={filters.status} placeholder="All statuses" options={["draft", "published", "withdrawn", "completed"]} onChange={(status) => setFilters({ ...filters, status: status as ListingFilters["status"] })} />
          <FilterSelect ariaLabel="Filter by listing channel" value={filters.channel} placeholder="All channels" options={["sale", "recycling"]} onChange={(channel) => setFilters({ ...filters, channel: channel as ListingFilters["channel"] })} />
          <Select value={filters.sort} onValueChange={(sort) => { const next = { ...filters, sort: sort as ListingFilters["sort"] }; setFilters(next); navigate(next); }}>
            <SelectTrigger aria-label="Sort listings" className="h-8 w-[10.25rem] text-xs"><ArrowUpDown className="mr-1 size-3.5" aria-hidden /><SelectValue /></SelectTrigger>
            <SelectContent>{SORT_OPTIONS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={isPending}><Search className="size-3.5" aria-hidden />Apply</Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={resetFilters}>Reset</Button>
        </form>

        <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div><h2 className="text-sm font-semibold text-[var(--color-text)]">All listings</h2><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Capacity and weight filters run on the server. Latest updates first by default.</p></div>
            {isPending && <Loader2 className="size-4 animate-spin text-[var(--color-text-muted)]" aria-label="Loading listings" />}
          </div>
          {initialPage.rows.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center"><Search className="size-6 text-[var(--color-text-muted)]" aria-hidden /><p className="font-medium text-[var(--color-text)]">No listings match these filters</p><p className="text-sm text-[var(--color-text-muted)]">Try widening the capacity or weight range.</p></div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[760px] table-fixed">
                <colgroup><col className="w-[30%]" /><col className="w-[16%]" /><col className="w-[10%]" /><col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[14%]" /><col className="w-[10%]" /><col className="w-8" /></colgroup>
                <TableHeader><TableRow><TableHead>Listing</TableHead><TableHead>Supplier</TableHead><TableHead>Capacity</TableHead><TableHead>Weight</TableHead><TableHead>Quantity</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{initialPage.rows.map((row) => <ListingRowView key={row.id} row={row} onOpen={() => void openDetails(row.id)} />)}</TableBody>
              </Table>
            </div>
          )}
          <div className="border-t border-[var(--color-border)] px-4 py-3"><TablePagination page={initialPage.page} pageSize={initialPage.pageSize} totalCount={initialPage.totalCount} totalPages={initialPage.totalPages} itemLabel="listing" onPageChange={(page) => navigate(filters, page)} /></div>
        </section>
      </div>

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) { setSelectedId(null); setDetail(null); } }}>
        <SheetContent side="right" className="w-full max-w-none gap-0 p-0 sm:w-[42rem] sm:max-w-[42rem] lg:w-[56rem] lg:max-w-[56rem] xl:w-[64rem] xl:max-w-[64rem]">
          <SheetHeader className="border-b border-[var(--color-border)] pr-14">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Protected detail</p>
            <SheetTitle className="truncate text-left">{detail?.title ?? (selectedId ? `Listing ${shortId(selectedId)}` : "Listing details")}</SheetTitle>
            <SheetDescription>Protected, read-only listing context with provenance and outbound targeting signals.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
            {detailPending && <div className="flex min-h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-[var(--color-text-muted)]" aria-label="Loading listing details" /></div>}
            {detailError && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{detailError}</p>}
            {detail && <ListingDetailView detail={detail} />}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}

function ListingRowView({ row, onOpen }: { row: ListingListRow; onOpen: () => void }) {
  return (
    <TableRow className="cursor-pointer [&>td]:py-3" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} aria-label={`Open details for ${row.title ?? row.id}`}>
      <TableCell className="max-w-0 overflow-hidden"><div className="min-w-0"><p className="truncate font-medium text-[var(--color-text)]" title={row.title ?? "Untitled listing"}>{row.title ?? "Untitled listing"}</p><p className="truncate text-xs text-[var(--color-text-muted)]" title={row.reference ?? row.id}>{row.reference ?? shortId(row.id)}</p></div></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><span className="block truncate text-sm text-[var(--color-text)]" title={row.supplierName ?? "Unknown supplier"}>{row.supplierName ?? "Unknown supplier"}</span></TableCell>
      <TableCell className="whitespace-nowrap"><span className="text-sm font-medium text-[var(--color-text)]">{formatNumber(row.packKwh, "kWh")}</span></TableCell>
      <TableCell className="whitespace-nowrap"><span className="text-sm font-medium text-[var(--color-text)]">{formatNumber(row.packWeightKg, "kg")}</span></TableCell>
      <TableCell className="whitespace-nowrap"><span className="text-sm text-[var(--color-text)]">{formatQuantity(row.quantity)}</span></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><div className="min-w-0 space-y-1">{statusBadge(row.status)}<p className="truncate text-[11px] text-[var(--color-text-muted)]">{row.channel ?? "—"} · {row.visibility ? VISIBILITY_LABELS[row.visibility] ?? row.visibility : "—"}</p></div></TableCell>
      <TableCell className="whitespace-nowrap"><span className="text-xs text-[var(--color-text-muted)]">{formatDate(row.updatedAt)}</span></TableCell>
      <TableCell><ChevronRight className="size-4 text-[var(--color-text-muted)]" aria-hidden /></TableCell>
    </TableRow>
  );
}

function DetailField({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-0.5 break-words text-sm text-[var(--color-text)]">{value === null || value === undefined || value === "" ? "—" : String(value)}</dd></div>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3"><p className="truncate text-xs text-[var(--color-text-muted)]" title={label}>{label}</p><p className="mt-1 truncate text-sm font-semibold text-[var(--color-text)]" title={value}>{value}</p>{detail && <p className="mt-1 break-words text-[11px] text-[var(--color-text-muted)]">{detail}</p>}</div>;
}

function externalUrl(value: string | null): string | null {
  if (!value) { return null; }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function OutboundContext({ detail, outbound }: { detail: ListingDetail; outbound: ListingOutboundContext }) {
  const messagesHref = `/platform-admin/messages?search=${encodeURIComponent(detail.id)}`;
  const proposalsHref = `/platform-admin/proposals?proposalListingFilter=${encodeURIComponent(detail.id)}`;
  const evidence = detail.evidence ?? { present: 0, total: 0, missing: [] };
  const evidenceDetail = evidence.total > 0 && evidence.missing.length > 0
    ? `Missing: ${evidence.missing.join(", ")}`
    : evidence.total > 0 ? "Core listing fields are present" : "Evidence coverage not recorded";
  return (
    <section className="space-y-3 border-t border-[var(--color-border)] pt-4" aria-label="Outbound targeting context">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Targeting context</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">Read-only signals from canonical marketplace activity. No outreach or moderation actions are available here.</p></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Metric label="Current availability" value={outbound.currentAvailability ?? detail.status ?? "Not recorded"} detail={detail.quantity === null ? "Quantity not recorded" : `${formatQuantity(detail.quantity)} units listed`} />
        <Metric label="Evidence coverage" value={`${evidence.present}/${evidence.total}`} detail={evidenceDetail} />
        <Metric label="Buyer interest" value={`${outbound.enquiryCount} enquiries · ${outbound.dealCount} deals`} detail={`${outbound.offerCount} offers recorded`} />
        <Metric label="Marketplace contact" value={formatDateTime(outbound.lastMarketplaceContactAt)} detail={`${outbound.conversationCount} linked conversation${outbound.conversationCount === 1 ? "" : "s"}`} />
        <Metric label="Target status" value={outbound.targetStatus ?? "Not recorded"} detail="No separate outbound target record exists" />
        <Metric label="Buyer segments" value={outbound.buyerSegments.length > 0 ? outbound.buyerSegments.join(", ") : "Not recorded"} detail="Derived from linked counterpart accounts" />
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <a href={messagesHref} className="inline-flex items-center gap-1.5 text-[var(--color-accent)] hover:underline"><MessageSquare className="size-3.5" aria-hidden />Open linked messages</a>
        <a href={proposalsHref} className="inline-flex items-center gap-1.5 text-[var(--color-accent)] hover:underline"><ExternalLink className="size-3.5" aria-hidden />Open linked proposals</a>
      </div>
      {outbound.recentOffers.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Recent offers</p><ul className="mt-2 space-y-2">{outbound.recentOffers.map((offer) => <li key={offer.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"><span className="min-w-0 truncate text-[var(--color-text)]" title={offer.counterpartName ?? offer.id}>{offer.counterpartName ?? "Unknown counterpart"} · {offer.kind}</span><span className="shrink-0 text-[var(--color-text-muted)]">{offer.status ?? "status unavailable"}</span></li>)}</ul></div>}
      {outbound.opportunityLinks.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Opportunity links</p><ul className="mt-2 space-y-2">{outbound.opportunityLinks.map((link) => <li key={link.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"><span className="min-w-0 truncate text-[var(--color-text)]" title={link.accountName ?? link.id}>{link.accountName ?? "Unknown recycler"} · {link.linkType ?? "link"}</span><span className="shrink-0 text-[var(--color-text-muted)]">{link.state ?? "state unavailable"}</span></li>)}</ul></div>}
      {outbound.conversations.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Linked conversations</p><ul className="mt-2 space-y-2">{outbound.conversations.map((conversation) => <li key={conversation.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"><span className="min-w-0 truncate text-[var(--color-text)]" title={conversation.lastMessagePreview ?? conversation.id}>{conversation.lastMessagePreview ?? "No preview recorded"}</span><span className="shrink-0 text-[var(--color-text-muted)]">{formatDateTime(conversation.lastMessageAt)}</span></li>)}</ul></div>}
    </section>
  );
}

function ListingDetailView({ detail }: { detail: ListingDetail }) {
  const publicHref = detail.seoSlug
    && detail.status === "published"
    && detail.visibility === "public"
    ? detail.channel === "recycling"
      ? `/recycler/opportunities/${encodeURIComponent(detail.seoSlug)}`
      : detail.channel === "sale"
        ? `/marketplace/${encodeURIComponent(detail.seoSlug)}`
        : null
    : null;
  const provenance = detail.provenance ?? { createdByUserId: null, sourceLabel: null, sourceUrl: null, metadata: {} };
  const sourceHref = externalUrl(provenance.sourceUrl);
  return (
    <div className="space-y-5">
      <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <DetailField label="Supplier" value={detail.supplierName} />
        <DetailField label="Canonical ID" value={detail.id} />
        <DetailField label="Reference" value={detail.reference} />
        <DetailField label="Slug" value={detail.seoSlug} />
        <DetailField label="Status" value={detail.status} />
        <DetailField label="Channel" value={detail.channel} />
        <DetailField label="Visibility" value={detail.visibility ? VISIBILITY_LABELS[detail.visibility] ?? detail.visibility : null} />
        <DetailField label="Quantity" value={formatQuantity(detail.quantity)} />
        <DetailField label="Pack capacity" value={formatNumber(detail.packKwh, "kWh")} />
        <DetailField label="Pack weight" value={formatNumber(detail.packWeightKg, "kg")} />
        <DetailField label="Manufacturer" value={detail.manufacturer} />
        <DetailField label="Model" value={detail.model} />
        <DetailField label="Format" value={detail.format} />
        <DetailField label="Chemistry" value={detail.chemistry} />
        <DetailField label="Cell chemistry" value={detail.cellChemistryDetail} />
        <DetailField label="Location" value={[detail.locationCity, detail.locationRegion, detail.locationCountry].filter(Boolean).join(", ")} />
        <DetailField label="Minimum order" value={detail.minimumOrderQuantity} />
        <DetailField label="Year manufactured" value={detail.yearManufacture} />
        <DetailField label="Nominal voltage" value={detail.voltageNominal ? `${detail.voltageNominal} V` : null} />
        <DetailField label="State of health" value={detail.soh ? `${detail.soh}%` : null} />
        <DetailField label="Created" value={formatDate(detail.createdAt)} />
        <DetailField label="Updated" value={formatDate(detail.updatedAt)} />
      </dl>
      <OutboundContext detail={detail} outbound={detail.outbound ?? EMPTY_OUTBOUND} />
      <section className="space-y-3 border-t border-[var(--color-border)] pt-4" aria-label="Listing provenance">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Source and provenance</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">Exact metadata from the canonical listing record. Values are not inferred from the title.</p></div>
        <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <DetailField label="Source" value={provenance.sourceLabel ?? "Not recorded"} />
          <DetailField label="Created by user ID" value={provenance.createdByUserId} />
        </dl>
        {sourceHref && <a href={sourceHref} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-[var(--color-accent)] hover:underline" title={sourceHref}>Open recorded source <ExternalLink className="size-3.5 shrink-0" aria-hidden /></a>}
        <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-muted)]">{JSON.stringify(provenance.metadata ?? {}, null, 2)}</pre>
      </section>
      {detail.description && <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Description</p><p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm leading-6 text-[var(--color-text)]">{detail.description}</p></div>}
      <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Condition data</p><pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-muted)]">{JSON.stringify(detail.condition, null, 2)}</pre></div>
      {publicHref ? <a href={publicHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-accent)] hover:underline">Open authoritative listing <ExternalLink className="size-3.5" aria-hidden /></a> : <p className="text-xs text-[var(--color-text-muted)]">No public link is shown for private or unpublished stock; the ID and reference above identify the canonical admin record.</p>}
    </div>
  );
}

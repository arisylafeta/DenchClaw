"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpDown, ChevronRight, Loader2, Search } from "lucide-react";

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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/platform-admin/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/platform-admin/ui/table";
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
import { getStockDetails } from "./actions";
import {
  STOCK_STATUSES,
  type StockDetail,
  type StockFilters,
  type StockListRow,
  type StockPage,
  type StockStatus,
} from "./contract";

const SORT_OPTIONS = [
  ["updated_desc", "Recently updated"],
  ["uploaded_desc", "Recently uploaded"],
  ["supplier_asc", "Supplier A–Z"],
  ["status_asc", "Status A–Z"],
] as const;

function formatDate(value: string | null): string {
  if (!value) {return "—";}
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null): string {
  if (!value) {return "—";}
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value: number | null, unit: string): string {
  return value === null ? "—" : `${value.toLocaleString()} ${unit}`;
}

function vehicleLabel(row: StockListRow): string {
  return [row.make, row.model, row.year].filter(Boolean).join(" ") || "Unidentified stock";
}

function statusBadge(status: StockStatus) {
  const classes: Record<StockStatus, string> = {
    unverified: "border-slate-300 bg-slate-50 text-slate-700",
    available: "border-emerald-300 bg-emerald-50 text-emerald-800",
    listed: "border-blue-300 bg-blue-50 text-blue-800",
    contacted: "border-amber-300 bg-amber-50 text-amber-800",
    in_deal: "border-violet-300 bg-violet-50 text-violet-800",
    sold: "border-teal-300 bg-teal-50 text-teal-800",
    unavailable: "border-zinc-300 bg-zinc-100 text-zinc-700",
  };
  return (
    <Badge variant="outline" className={classes[status]}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

function buildQuery(filters: StockFilters, page: number): string {
  const params = new URLSearchParams();
  if (page > 1) {params.set("page", String(page));}
  for (const key of [
    "search",
    "supplier",
    "status",
    "chemistry",
    "scope",
    "commercialBucket",
  ] as const) {
    if (filters[key]) {params.set(key, filters[key]);}
  }
  if (filters.sort !== "updated_desc") {params.set("sort", filters.sort);}
  return params.toString();
}

function FilterSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value || "all"} onValueChange={(next) => onChange(next === "all" ? "" : next)}>
      <SelectTrigger aria-label={label} className="h-8 w-[10.5rem] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option.replaceAll("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StockClient({ initialPage }: { initialPage: StockPage }) {
  const router = useRouter();
  const [filters, setFilters] = useState(initialPage.filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StockDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [isPending, startTransition] = useTransition();
  const detailRequestRef = useRef(0);

  useEffect(() => setFilters(initialPage.filters), [initialPage.filters]);

  const navigate = (next: StockFilters, page = 1) => {
    const query = buildQuery(next, page);
    startTransition(() =>
      router.replace(`/platform-admin/stock${query ? `?${query}` : ""}`),
    );
  };

  const openDetails = async (id: string) => {
    const request = ++detailRequestRef.current;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailPending(true);
    try {
      const result = await getStockDetails(id);
      if (request !== detailRequestRef.current) {return;}
      if (!result) {setDetailError("This stock item is no longer available.");}
      else {setDetail(result);}
    } catch {
      if (request !== detailRequestRef.current) {return;}
      setDetailError("The protected stock details could not be loaded.");
    } finally {
      if (request === detailRequestRef.current) {setDetailPending(false);}
    }
  };

  const reset = () => {
    const empty: StockFilters = {
      search: "",
      supplier: "",
      status: "",
      chemistry: "",
      scope: "",
      commercialBucket: "",
      sort: "updated_desc",
    };
    setFilters(empty);
    navigate(empty);
  };

  return (
    <main className="min-h-full bg-[var(--color-bg)] p-4 sm:p-6">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Dench admin
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-text)]">
              Stock
            </h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              All supplier stock, including unverified historical intake and enrichment state.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <Badge variant="outline" className="border-[var(--color-border)]">
              {initialPage.totalCount.toLocaleString()} shown
            </Badge>
            <Badge variant="outline" className="border-[var(--color-border)]">
              {initialPage.allCount.toLocaleString()} total
            </Badge>
            <Badge variant="outline" className="border-[var(--color-border)]">
              Snapshot {formatDateTime(initialPage.snapshotAt)}
            </Badge>
          </div>
        </header>

        <form
          className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(filters);
          }}
        >
          <div className="relative min-w-[15rem] flex-1 basis-[20rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <Input
              aria-label="Search stock"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder="Search stock ID, vehicle, part number, or location"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <FilterSelect label="Filter by supplier" value={filters.supplier} placeholder="All suppliers" options={initialPage.options.suppliers} onChange={(supplier) => setFilters({ ...filters, supplier })} />
          <FilterSelect label="Filter by stock status" value={filters.status} placeholder="All statuses" options={STOCK_STATUSES} onChange={(status) => setFilters({ ...filters, status: status as StockFilters["status"] })} />
          <FilterSelect label="Filter by chemistry" value={filters.chemistry} placeholder="All chemistry" options={initialPage.options.chemistries} onChange={(chemistry) => setFilters({ ...filters, chemistry })} />
          <FilterSelect label="Filter by scope" value={filters.scope} placeholder="All scopes" options={initialPage.options.scopes} onChange={(scope) => setFilters({ ...filters, scope })} />
          <FilterSelect label="Filter by commercial bucket" value={filters.commercialBucket} placeholder="All buckets" options={initialPage.options.commercialBuckets} onChange={(commercialBucket) => setFilters({ ...filters, commercialBucket })} />
          <Select value={filters.sort} onValueChange={(sort) => { const next = { ...filters, sort: sort as StockFilters["sort"] }; setFilters(next); navigate(next); }}>
            <SelectTrigger aria-label="Sort stock" className="h-8 w-[10.5rem] text-xs"><ArrowUpDown className="mr-1 size-3.5" /><SelectValue /></SelectTrigger>
            <SelectContent>{SORT_OPTIONS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={isPending}><Search className="size-3.5" />Apply</Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={reset}>Reset</Button>
        </form>

        <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div><h2 className="text-sm font-semibold text-[var(--color-text)]">All stock</h2><p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Historical rows remain unverified until a supplier confirms availability.</p></div>
            {isPending && <Loader2 className="size-4 animate-spin text-[var(--color-text-muted)]" aria-label="Loading stock" />}
          </div>
          {initialPage.rows.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center"><Search className="size-6 text-[var(--color-text-muted)]" /><p className="font-medium text-[var(--color-text)]">No stock matches these filters</p><p className="text-sm text-[var(--color-text-muted)]">Try a broader supplier, status, chemistry, or text search.</p></div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[980px] table-fixed">
                <colgroup><col className="w-[16%]" /><col className="w-[11%]" /><col className="w-[20%]" /><col className="w-[13%]" /><col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[12%]" /><col className="w-[9%]" /><col className="w-8" /></colgroup>
                <TableHeader><TableRow><TableHead>Stock ID</TableHead><TableHead>Supplier</TableHead><TableHead>Vehicle</TableHead><TableHead>Part number</TableHead><TableHead>Chemistry</TableHead><TableHead>Quantity</TableHead><TableHead>Status</TableHead><TableHead>Uploaded</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{initialPage.rows.map((row) => <StockRowView key={row.id} row={row} onOpen={() => void openDetails(row.id)} />)}</TableBody>
              </Table>
            </div>
          )}
          <div className="border-t border-[var(--color-border)] px-4 py-3"><TablePagination page={initialPage.page} pageSize={initialPage.pageSize} totalCount={initialPage.totalCount} totalPages={initialPage.totalPages} itemLabel="stock item" onPageChange={(page) => navigate(initialPage.filters, page)} /></div>
        </section>
      </div>

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) { detailRequestRef.current += 1; setSelectedId(null); setDetail(null); setDetailPending(false); } }}>
        <SheetContent side="right" className="w-full max-w-none gap-0 p-0 sm:w-[42rem] sm:max-w-[42rem] lg:w-[56rem] lg:max-w-[56rem]">
          <SheetHeader className="border-b border-[var(--color-border)] pr-14">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Protected detail</p>
            <SheetTitle className="truncate text-left">{detail ? `${detail.supplier} · ${detail.stockId}` : "Stock details"}</SheetTitle>
            <SheetDescription>Read-only supplier stock, enrichment state, source dates, and evidence.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
            {detailPending && <div className="flex min-h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-[var(--color-text-muted)]" aria-label="Loading stock details" /></div>}
            {detailError && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{detailError}</p>}
            {detail && <StockDetailView detail={detail} />}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}

function StockRowView({ row, onOpen }: { row: StockListRow; onOpen: () => void }) {
  return (
    <TableRow className="cursor-pointer [&>td]:py-3" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} aria-label={`Open details for ${row.supplier} ${row.stockId}`}>
      <TableCell className="max-w-0 overflow-hidden"><p className="truncate font-medium text-[var(--color-text)]" title={row.stockId}>{row.stockId}</p><p className="truncate text-xs text-[var(--color-text-muted)]">{row.commercialBucket?.replaceAll("_", " ") ?? "No commercial bucket"}</p></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><span className="block truncate" title={row.supplier}>{row.supplier}</span></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><p className="truncate font-medium" title={vehicleLabel(row)}>{vehicleLabel(row)}</p><p className="truncate text-xs text-[var(--color-text-muted)]">{row.location ?? "Location unavailable"}</p></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><span className="block truncate" title={row.partNumber ?? ""}>{row.partNumber ?? "—"}</span></TableCell>
      <TableCell className="max-w-0 overflow-hidden"><p className="truncate" title={row.chemistry ?? ""}>{row.chemistry ?? "—"}</p><p className="text-xs text-[var(--color-text-muted)]">{formatNumber(row.capacityKwh, "kWh")}</p></TableCell>
      <TableCell>{row.quantity.toLocaleString()}</TableCell>
      <TableCell><div className="space-y-1">{statusBadge(row.stockStatus)}<p className="text-[11px] text-[var(--color-text-muted)]">{row.enrichStatus}</p></div></TableCell>
      <TableCell><span className="text-xs text-[var(--color-text-muted)]">{formatDate(row.createdAt)}</span></TableCell>
      <TableCell><ChevronRight className="size-4 text-[var(--color-text-muted)]" /></TableCell>
    </TableRow>
  );
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  const shown = value === null || value === undefined || value === "" ? "—" : String(value);
  return <div><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-0.5 break-words text-sm text-[var(--color-text)]">{shown}</dd></div>;
}

function StockDetailView({ detail }: { detail: StockDetail }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">{statusBadge(detail.stockStatus)}<Badge variant="outline">Enrichment: {detail.enrichStatus}</Badge>{detail.supplierConfirmed && <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">Supplier confirmed</Badge>}</div>
      <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <DetailField label="Supplier" value={detail.supplier} /><DetailField label="Stock ID" value={detail.stockId} />
        <DetailField label="Make" value={detail.make} /><DetailField label="Model" value={detail.model} />
        <DetailField label="Model detail" value={detail.modelDetail} /><DetailField label="Year" value={detail.year} />
        <DetailField label="Powertrain" value={detail.powertrain} /><DetailField label="Part number" value={detail.partNumber} />
        <DetailField label="Part number status" value={detail.partNumberStatus} /><DetailField label="Scope" value={detail.scope} />
        <DetailField label="Chemistry" value={detail.chemistry} /><DetailField label="Capacity" value={formatNumber(detail.capacityKwh, "kWh")} />
        <DetailField label="Voltage" value={formatNumber(detail.voltageV, "V")} /><DetailField label="Weight" value={formatNumber(detail.weightKg, "kg")} />
        <DetailField label="Quantity" value={detail.quantity} /><DetailField label="Price" value={detail.price} />
        <DetailField label="Location" value={detail.location} /><DetailField label="Condition" value={detail.condition} />
        <DetailField label="SOH" value={detail.sohPercent === null ? null : `${detail.sohPercent}%`} /><DetailField label="Tested" value={detail.tested === null ? null : detail.tested ? "Yes" : "No"} />
        <DetailField label="Completeness" value={detail.completeness} /><DetailField label="Commercial bucket" value={detail.commercialBucket} />
        <DetailField label="Uploaded" value={formatDateTime(detail.createdAt)} /><DetailField label="Updated" value={formatDateTime(detail.updatedAt)} />
        <DetailField label="Supplier confirmed" value={formatDateTime(detail.supplierConfirmedAt)} /><DetailField label="Enriched" value={formatDateTime(detail.enrichedAt)} />
      </dl>
      <section className="border-t border-[var(--color-border)] pt-4"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Source flags</p><div className="mt-2 flex flex-wrap gap-2"><Badge variant="outline">August: {detail.inAugust ? "yes" : "no"}</Badge><Badge variant="outline">12+ months: {detail.aged12m ? "yes" : "no"}</Badge><Badge variant="outline">September aged: {detail.inSeptemberAged ? "yes" : "no"}</Badge></div></section>
      {detail.description && <section><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Description</p><p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">{detail.description}</p></section>}
      {(detail.conditionDetail || detail.comments) && <section><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Condition and comments</p><p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">{[detail.conditionDetail, detail.comments].filter(Boolean).join("\n\n")}</p></section>}
      <section><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Evidence</p><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-muted)]">{JSON.stringify(detail.evidence, null, 2)}</pre></section>
      <section><p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Variable attributes</p><pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-muted)]">{JSON.stringify(detail.attributes, null, 2)}</pre></section>
    </div>
  );
}

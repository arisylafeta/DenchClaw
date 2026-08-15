"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ImageIcon } from "lucide-react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";

import { CrmListShell } from "@/app/components/crm/crm-list-shell";
import { DataTable } from "@/app/components/workspace/data-table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/app/components/platform-admin/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/platform-admin/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/platform-admin/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/platform-admin/ui/tabs";
import { getBatteryReviewDetails, getBatteryReviewPage } from "./actions";
import type { BatteryEvidenceRow, BatteryFilterOptions, BatteryReviewPage, BatteryReviewRow, BatteryReviewTab } from "./actions";

type CanonicalPage = BatteryReviewPage<BatteryReviewRow>;
type EvidencePage = BatteryReviewPage<BatteryEvidenceRow>;

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function date(value: unknown): string {
  if (typeof value !== "string") return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function catalogueImageUrl(row: BatteryReviewRow): string | null {
  if (typeof row.catalogue_image_url === "string" && row.catalogue_image_url.trim()) {
    return row.catalogue_image_url;
  }
  if (Array.isArray(row.image_urls)) {
    const imageUrl = row.image_urls.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return imageUrl ?? null;
  }
  return null;
}

type EvidenceChange = { field: string; previous: unknown; submitted: unknown };

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function evidenceChanges(row: BatteryEvidenceRow): EvidenceChange[] {
  const previousValues = valueRecord(row.previous_values);
  const submittedValues = valueRecord(row.submitted_values);
  const changedFields = Array.isArray(row.changed_fields)
    ? row.changed_fields.filter((field): field is string => typeof field === "string")
    : [];
  const fields = changedFields.length > 0
    ? changedFields
    : [...new Set([...Object.keys(previousValues), ...Object.keys(submittedValues)])];

  return fields.map((field) => ({
    field,
    previous: previousValues[field],
    submitted: submittedValues[field],
  }));
}

function canonicalLabel(row: BatteryReviewRow | null): string {
  if (!row) return "No selected canonical battery";
  return [row.manufacturer, row.model, row.nominal_kwh == null ? null : `${row.nominal_kwh} kWh`]
    .filter(Boolean)
    .join(" · ") || display(row.id);
}

function compact(value: unknown): string {
  const text = display(value);
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

function ChangeSet({ changes, detailed = false }: { changes: EvidenceChange[]; detailed?: boolean }) {
  if (changes.length === 0) {
    return <span className="text-sm text-muted-foreground">No field-level change data captured.</span>;
  }

  const visibleChanges = detailed ? changes : changes.slice(0, 4);
  return (
    <div className={detailed ? "overflow-x-auto rounded-md border" : "space-y-1"}>
      {detailed ? (
        <Table>
          <TableHeader><TableRow><TableHead>Field</TableHead><TableHead>Previous</TableHead><TableHead>Submitted</TableHead></TableRow></TableHeader>
          <TableBody>{visibleChanges.map((change) => <TableRow key={change.field}><TableCell className="font-mono text-xs">{change.field}</TableCell><TableCell className="max-w-64 break-words text-muted-foreground">{display(change.previous)}</TableCell><TableCell className="max-w-64 break-words font-medium">{display(change.submitted)}</TableCell></TableRow>)}</TableBody>
        </Table>
      ) : visibleChanges.map((change) => (
        <div key={change.field} className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-2 text-xs">
          <span className="font-mono text-muted-foreground">{change.field}</span>
          <span className="truncate" title={`${display(change.previous)} → ${display(change.submitted)}`}><span className="text-muted-foreground">{compact(change.previous)}</span> <span aria-hidden="true">→</span> <span className="font-medium">{compact(change.submitted)}</span></span>
        </div>
      ))}
      {!detailed && changes.length > visibleChanges.length ? <p className="pt-1 text-xs text-muted-foreground">+{changes.length - visibleChanges.length} more changes</p> : null}
    </div>
  );
}

function JsonDetails({ row, title }: { row: BatteryReviewRow; title: string }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {Object.entries(row).filter(([key]) => key !== "linked_battery").map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
            <dd className="mt-1 break-words text-sm">{display(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function BatteryReviewClient({ initialCanonical, initialEvidence, filterOptions }: { initialCanonical: CanonicalPage; initialEvidence: EvidencePage; filterOptions: BatteryFilterOptions }) {
  const [tab, setTab] = useState<BatteryReviewTab>("canonical");
  const [canonical, setCanonical] = useState(initialCanonical);
  const [evidence, setEvidence] = useState(initialEvidence);
  const [search, setSearch] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [chemistry, setChemistry] = useState("");
  const [sort, setSort] = useState("updated_at");
  const [ascending, setAscending] = useState(false);
  const [details, setDetails] = useState<{ row: BatteryReviewRow; linked: BatteryReviewRow | null; label: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isDetailsPending, startDetailsTransition] = useTransition();
  const requestId = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = tab === "canonical" ? canonical : evidence;

  const load = (next: Partial<{ tab: BatteryReviewTab; page: number; pageSize: number; search: string; manufacturer: string; chemistry: string; sort: string; ascending: boolean }> = {}) => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    const nextTab = next.tab ?? tab;
    const nextSearch = next.search ?? search;
    const nextManufacturer = next.manufacturer ?? manufacturer;
    const nextChemistry = next.chemistry ?? chemistry;
    const nextSort = next.sort ?? sort;
    const nextAscending = next.ascending ?? ascending;
    const nextPageSize = next.pageSize ?? (nextTab === "canonical" ? canonical.pageSize : evidence.pageSize);
    const currentRequestId = ++requestId.current;
    startTransition(async () => {
      setLoadError(null);
      try {
        const result = await getBatteryReviewPage({ tab: nextTab, page: next.page ?? 1, pageSize: nextPageSize, search: nextSearch, manufacturer: nextManufacturer, chemistry: nextChemistry, sort: nextSort, ascending: nextAscending });
        if (currentRequestId !== requestId.current) return;
        if (nextTab === "canonical") setCanonical(result as CanonicalPage);
        else setEvidence(result as EvidencePage);
      } catch (error) {
        if (currentRequestId !== requestId.current) return;
        setLoadError(error instanceof Error ? error.message : "Could not load battery review data");
      }
    });
  };

  const changeTab = (value: string) => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    const nextTab = value as BatteryReviewTab;
    setTab(nextTab);
    setSearch("");
    setManufacturer("");
    setChemistry("");
    const nextSort = nextTab === "canonical" ? "updated_at" : "created_at";
    setSort(nextSort);
    setAscending(false);
    load({ tab: nextTab, page: 1, search: "", manufacturer: "", chemistry: "", sort: nextSort, ascending: false });
  };

  const scheduleSearch = (value: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load({ page: 1, search: value }), 300);
  };

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestId.current += 1;
  }, []);

  const setCanonicalFilter = (field: "manufacturer" | "chemistry", value: string) => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    const nextValue = value === "__all__" ? "" : value;
    if (field === "manufacturer") setManufacturer(nextValue);
    else setChemistry(nextValue);
    load({ page: 1, [field]: nextValue });
  };

  const handleSortChange = (sorting: SortingState) => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    const next = sorting[0];
    const nextSort = next?.id ?? (tab === "canonical" ? "updated_at" : "created_at");
    const nextAscending = next ? !next.desc : false;
    setSort(nextSort);
    setAscending(nextAscending);
    load({ page: 1, sort: nextSort, ascending: nextAscending });
  };

  const openDetails = (detailTab: BatteryReviewTab, id: unknown) => {
    if (typeof id !== "string") return;
    setLoadError(null);
    startDetailsTransition(async () => {
      try {
        const result = await getBatteryReviewDetails({ tab: detailTab, id });
        setDetails({
          ...result,
          label: detailTab === "canonical" ? "Canonical battery" : "Battery evidence",
        });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Could not load battery details");
      }
    });
  };

  const canonicalColumns = useMemo<ColumnDef<BatteryReviewRow>[]>(() => [
    {
      id: "image",
      header: "Image",
      cell: ({ row }) => catalogueImageUrl(row.original) ? (
        <img
          src={catalogueImageUrl(row.original) ?? ""}
          alt=""
          className="size-9 rounded object-cover"
          onError={(event) => { event.currentTarget.style.display = "none"; }}
        />
      ) : <ImageIcon className="size-4" aria-label="No catalogue image" style={{ color: "var(--color-text-muted)" }} />,
      size: 72,
      enableSorting: false,
      enableHiding: false,
    },
    { accessorKey: "manufacturer", header: "Manufacturer", cell: ({ getValue }) => display(getValue()), size: 180 },
    { accessorKey: "model", header: "Model", cell: ({ getValue }) => display(getValue()), size: 200 },
    { accessorKey: "chemistry", header: "Chemistry", cell: ({ getValue }) => display(getValue()), size: 130 },
    { accessorKey: "nominal_kwh", header: "Nominal kWh", cell: ({ getValue }) => display(getValue()), size: 130 },
    { accessorKey: "part_number", header: "Part number", cell: ({ getValue }) => display(getValue()), size: 180, enableSorting: false },
    { accessorKey: "updated_at", header: "Updated", cell: ({ getValue }) => date(getValue()), size: 180 },
  ], []);

  const evidenceColumns = useMemo<ColumnDef<BatteryEvidenceRow>[]>(() => [
    {
      id: "canonical_context",
      accessorFn: (row) => `${canonicalLabel(row.linked_battery)} ${row.selected_battery_id ?? ""}`,
      header: "Canonical context",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{canonicalLabel(row.original.linked_battery)}</div>
          <div className="mt-1 font-mono text-xs" style={{ color: "var(--color-text-muted)" }}>
            {row.original.selected_battery_id ?? "No selected ID"}
          </div>
        </div>
      ),
      size: 300,
      enableSorting: false,
    },
    { id: "changes", header: "Proposed change", cell: ({ row }) => <ChangeSet changes={evidenceChanges(row.original)} />, size: 420, enableSorting: false },
    {
      accessorKey: "source_context",
      header: "Source",
      cell: ({ row }) => (
        <div>
          <div>{display(row.original.source_context)}</div>
          <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>{display(row.original.source_flow)}</div>
        </div>
      ),
      size: 240,
    },
    { accessorKey: "created_at", header: "Captured", cell: ({ getValue }) => date(getValue()), size: 180 },
  ], []);

  return (
    <>
      <CrmListShell
        title="Battery review"
        count={active.totalCount}
        toolbar={(
          <Tabs value={tab} onValueChange={changeTab}>
            <TabsList>
              <TabsTrigger value="canonical">Canonical</TabsTrigger>
              <TabsTrigger value="evidence">Battery Evidence</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          {loadError ? (
            <p role="alert" className="shrink-0 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
          ) : null}
          <div className="min-h-0 flex-1">
            {tab === "canonical" ? (
              <DataTable<BatteryReviewRow, unknown>
                key="canonical"
                columns={canonicalColumns}
                data={canonical.rows}
                loading={isPending}
                enableGlobalFilter
                globalFilter={search}
                onGlobalFilterChange={setSearch}
                onServerSearch={scheduleSearch}
                searchPlaceholder="Search canonical batteries..."
                enableSorting
                onSortChange={handleSortChange}
                enableRowSelection
                onRowClick={(row) => !isDetailsPending && openDetails("canonical", row.id)}
                getRowId={(row) => String(row.id)}
                onRefresh={() => load({ page: canonical.page })}
                serverPagination={{
                  totalCount: canonical.totalCount,
                  page: canonical.page,
                  pageSize: canonical.pageSize,
                  onPageChange: (page) => load({ page }),
                  onPageSizeChange: (pageSize) => load({ page: 1, pageSize }),
                }}
                toolbarExtra={(
                  <>
                    <Select value={manufacturer || "__all__"} onValueChange={(value) => setCanonicalFilter("manufacturer", value)}>
                      <SelectTrigger className="h-8 w-48 text-xs" aria-label="Filter by manufacturer"><SelectValue placeholder="All manufacturers" /></SelectTrigger>
                      <SelectContent><SelectItem value="__all__">All manufacturers</SelectItem>{filterOptions.manufacturers.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                    </Select>
                    <Select value={chemistry || "__all__"} onValueChange={(value) => setCanonicalFilter("chemistry", value)}>
                      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by chemistry"><SelectValue placeholder="All chemistries" /></SelectTrigger>
                      <SelectContent><SelectItem value="__all__">All chemistries</SelectItem>{filterOptions.chemistries.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                    </Select>
                  </>
                )}
              />
            ) : (
              <DataTable<BatteryEvidenceRow, unknown>
                key="evidence"
                columns={evidenceColumns}
                data={evidence.rows}
                loading={isPending}
                enableGlobalFilter
                globalFilter={search}
                onGlobalFilterChange={setSearch}
                onServerSearch={scheduleSearch}
                searchPlaceholder="Search battery evidence..."
                enableSorting
                onSortChange={handleSortChange}
                enableRowSelection
                onRowClick={(row) => !isDetailsPending && openDetails("evidence", row.id)}
                getRowId={(row) => row.id}
                onRefresh={() => load({ page: evidence.page })}
                serverPagination={{
                  totalCount: evidence.totalCount,
                  page: evidence.page,
                  pageSize: evidence.pageSize,
                  onPageChange: (page) => load({ page }),
                  onPageSizeChange: (pageSize) => load({ page: 1, pageSize }),
                }}
              />
            )}
          </div>
        </div>
      </CrmListShell>

      <Dialog open={Boolean(details)} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
          <DialogHeader><DialogTitle>{details?.label} details</DialogTitle><DialogDescription>Raw live table values are shown read-only. Evidence comparison uses only the explicitly selected canonical link.</DialogDescription></DialogHeader>
          {details ? <div className="space-y-7">{details.label === "Battery evidence" ? <><section className="space-y-3"><h3 className="text-sm font-semibold">Proposed field changes</h3><ChangeSet changes={evidenceChanges(details.row as BatteryEvidenceRow)} detailed /></section><JsonDetails row={details.linked ?? { status: "No selected canonical battery is linked to this evidence row." }} title="Current selected canonical context" /></> : null}<JsonDetails row={details.row} title={details.label} /></div> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

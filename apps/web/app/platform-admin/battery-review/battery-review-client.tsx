"use client";

import { useState, useTransition } from "react";
import { ArrowDownIcon, ArrowUpIcon, DatabaseIcon, EyeIcon, FileSearchIcon, ImageIcon, Loader2Icon, SearchIcon } from "lucide-react";

import { Button } from "@/app/components/platform-admin/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/platform-admin/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/app/components/platform-admin/ui/dialog";
import { Input } from "@/app/components/platform-admin/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/platform-admin/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/app/components/platform-admin/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/platform-admin/ui/tabs";
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
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

  const active = tab === "canonical" ? canonical : evidence;

  const load = (next: Partial<{ tab: BatteryReviewTab; page: number; search: string; manufacturer: string; chemistry: string; sort: string; ascending: boolean }> = {}) => {
    const nextTab = next.tab ?? tab;
    const nextSearch = next.search ?? search;
    const nextManufacturer = next.manufacturer ?? manufacturer;
    const nextChemistry = next.chemistry ?? chemistry;
    const nextSort = next.sort ?? sort;
    const nextAscending = next.ascending ?? ascending;
    startTransition(async () => {
      setLoadError(null);
      try {
        const result = await getBatteryReviewPage({ tab: nextTab, page: next.page ?? 1, search: nextSearch, manufacturer: nextManufacturer, chemistry: nextChemistry, sort: nextSort, ascending: nextAscending });
        if (nextTab === "canonical") setCanonical(result as CanonicalPage);
        else setEvidence(result as EvidencePage);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Could not load battery review data");
      }
    });
  };

  const changeTab = (value: string) => {
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

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    load({ page: 1 });
  };

  const setCanonicalFilter = (field: "manufacturer" | "chemistry", value: string) => {
    const nextValue = value === "__all__" ? "" : value;
    if (field === "manufacturer") setManufacturer(nextValue);
    else setChemistry(nextValue);
    load({ page: 1, [field]: nextValue });
  };

  const toggleSort = (column: string) => {
    const nextAscending = sort === column ? !ascending : true;
    setSort(column);
    setAscending(nextAscending);
    load({ page: 1, sort: column, ascending: nextAscending });
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

  const sortLabel = (column: string, label: string) => (
    <button type="button" className="inline-flex items-center gap-1 hover:text-[var(--color-text)]" onClick={() => toggleSort(column)}>
      {label}
      {sort === column ? (ascending ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />) : null}
    </button>
  );

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="font-instrument text-3xl tracking-tight text-[var(--color-text)]">Battery review</h1>
        <p className="mt-1 text-sm text-muted-foreground">Browse the live canonical battery catalogue and captured evidence. Review decisions are intentionally not enabled yet.</p>
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-5" />
            <CardTitle>Canonical data and evidence</CardTitle>
          </div>
          <CardDescription>All data is fetched server-side using the admin service-role boundary. Open a row to inspect every currently returned column.</CardDescription>
          <Tabs value={tab} onValueChange={changeTab}>
            <TabsList>
              <TabsTrigger value="canonical">Canonical</TabsTrigger>
              <TabsTrigger value="evidence">Battery Evidence</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={submitSearch} className="flex flex-wrap gap-2">
            <Input className="max-w-xl" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "canonical" ? "Search manufacturer, model, chemistry, or part number" : "Search source flow, source context, or evidence hash"} />
            {tab === "canonical" ? <>
              <Select value={manufacturer || "__all__"} onValueChange={(value) => setCanonicalFilter("manufacturer", value)}>
                <SelectTrigger className="w-48" aria-label="Filter by manufacturer"><SelectValue placeholder="All manufacturers" /></SelectTrigger>
                <SelectContent><SelectItem value="__all__">All manufacturers</SelectItem>{filterOptions.manufacturers.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={chemistry || "__all__"} onValueChange={(value) => setCanonicalFilter("chemistry", value)}>
                <SelectTrigger className="w-44" aria-label="Filter by chemistry"><SelectValue placeholder="All chemistries" /></SelectTrigger>
                <SelectContent><SelectItem value="__all__">All chemistries</SelectItem>{filterOptions.chemistries.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            </> : null}
            <Button type="submit" variant="outline" disabled={isPending}><SearchIcon /> Search</Button>
          </form>

          {isPending ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" /> Loading live data…</div> : null}
          {loadError ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}

          <div className="overflow-x-auto rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
            {tab === "canonical" ? (
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="w-14">Image</TableHead><TableHead>{sortLabel("manufacturer", "Manufacturer")}</TableHead><TableHead>{sortLabel("model", "Model")}</TableHead><TableHead>{sortLabel("chemistry", "Chemistry")}</TableHead><TableHead>{sortLabel("nominal_kwh", "Nominal kWh")}</TableHead><TableHead>Part number</TableHead><TableHead>{sortLabel("updated_at", "Updated")}</TableHead><TableHead className="text-right">Details</TableHead>
                </TableRow></TableHeader>
                <TableBody>{canonical.rows.length ? canonical.rows.map((row) => <TableRow key={String(row.id)}>
                  <TableCell>{catalogueImageUrl(row) ? <img src={catalogueImageUrl(row) ?? ""} alt="" className="size-9 rounded border object-cover" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <ImageIcon className="size-4 text-muted-foreground" aria-label="No catalogue image" />}</TableCell><TableCell className="font-medium">{display(row.manufacturer)}</TableCell><TableCell>{display(row.model)}</TableCell><TableCell>{display(row.chemistry)}</TableCell><TableCell>{display(row.nominal_kwh)}</TableCell><TableCell>{display(row.part_number)}</TableCell><TableCell>{date(row.updated_at)}</TableCell><TableCell className="text-right"><Button type="button" size="sm" variant="ghost" disabled={isDetailsPending} onClick={() => openDetails("canonical", row.id)}><EyeIcon /> View</Button></TableCell>
                </TableRow>) : <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No canonical batteries match this view.</TableCell></TableRow>}</TableBody>
              </Table>
            ) : (
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Canonical context</TableHead><TableHead className="min-w-96">Proposed change</TableHead><TableHead>{sortLabel("source_context", "Source")}</TableHead><TableHead>{sortLabel("created_at", "Captured")}</TableHead><TableHead className="text-right">Inspect</TableHead>
                </TableRow></TableHeader>
                <TableBody>{evidence.rows.length ? evidence.rows.map((row) => <TableRow key={row.id}>
                  <TableCell><div className="font-medium">{canonicalLabel(row.linked_battery)}</div><div className="mt-1 font-mono text-xs text-muted-foreground">{row.selected_battery_id ?? "No selected ID"}</div>{row.matched_battery_id && row.matched_battery_id !== row.selected_battery_id ? <div className="mt-1 text-xs text-muted-foreground">Identity match also recorded</div> : null}</TableCell><TableCell><ChangeSet changes={evidenceChanges(row)} /></TableCell><TableCell><div>{display(row.source_context)}</div><div className="text-xs text-muted-foreground">{display(row.source_flow)}</div></TableCell><TableCell>{date(row.created_at)}</TableCell><TableCell className="text-right"><Button type="button" size="sm" variant="ghost" disabled={isDetailsPending} onClick={() => openDetails("evidence", row.id)}><FileSearchIcon /> Inspect</Button></TableCell>
                </TableRow>) : <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">No battery evidence matches this view.</TableCell></TableRow>}</TableBody>
              </Table>
            )}
          </div>

          <TablePagination page={active.page} pageSize={active.pageSize} totalCount={active.totalCount} totalPages={Math.max(1, Math.ceil(active.totalCount / active.pageSize))} itemLabel={tab === "canonical" ? "canonical battery" : "evidence row"} onPageChange={(page) => load({ page })} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(details)} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
          <DialogHeader><DialogTitle>{details?.label} details</DialogTitle><DialogDescription>Raw live table values are shown read-only. Evidence comparison uses only the explicitly selected canonical link.</DialogDescription></DialogHeader>
          {details ? <div className="space-y-7">{details.label === "Battery evidence" ? <><section className="space-y-3"><h3 className="text-sm font-semibold">Proposed field changes</h3><ChangeSet changes={evidenceChanges(details.row as BatteryEvidenceRow)} detailed /></section><JsonDetails row={details.linked ?? { status: "No selected canonical battery is linked to this evidence row." }} title="Current selected canonical context" /></> : null}<JsonDetails row={details.row} title={details.label} /></div> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

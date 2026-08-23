"use client";

import {
  CheckCircle2Icon,
  EyeIcon,
  FileSearchIcon,
  Loader2Icon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/platform-admin/ui/card";
import { Checkbox } from "@/app/components/platform-admin/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/platform-admin/ui/dialog";
import { Input } from "@/app/components/platform-admin/ui/input";
import { Label } from "@/app/components/platform-admin/ui/label";
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
import { Textarea } from "@/app/components/platform-admin/ui/textarea";
import {
  getBatteryEvidencePage,
  reviewBatteryEvidence,
  searchCanonicalApplications,
  type BatteryEvidencePage,
  type BatteryEvidenceRow,
} from "./actions";
import {
  buildBatteryEvidenceDifferences,
  type BatteryEvidenceStatus,
  type CanonicalApplicationContext,
} from "./diff";

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "—";
}

function date(value: unknown): string {
  if (typeof value !== "string") {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function statusVariant(status: BatteryEvidenceStatus) {
  if (status === "applied") {
    return "default" as const;
  }
  if (status === "dismissed") {
    return "destructive" as const;
  }
  if (status === "verified") {
    return "secondary" as const;
  }
  return "outline" as const;
}

function DifferenceSummary({ row }: { row: BatteryEvidenceRow }) {
  if (!row.canonical_context) {
    return <span className="text-sm text-muted-foreground">No canonical application selected</span>;
  }
  if (row.differences.length === 0) {
    return <span className="text-sm text-muted-foreground">No applicable differences</span>;
  }
  return (
    <div className="space-y-1">
      {row.differences.slice(0, 3).map((difference) => (
        <div key={difference.field} className="text-xs">
          <span className="font-medium">{difference.label}:</span>{" "}
          <span className="text-muted-foreground">{display(difference.canonical)}</span>
          {" → "}
          <span>{display(difference.submitted)}</span>
        </div>
      ))}
      {row.differences.length > 3 ? (
        <p className="text-xs text-muted-foreground">+{row.differences.length - 3} more</p>
      ) : null}
    </div>
  );
}
export function BatteryReviewClient({ initialPage }: { initialPage: BatteryEvidencePage }) {
  const [pageData, setPageData] = useState(initialPage);
  const [status, setStatus] = useState<BatteryEvidenceStatus | "all">("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<BatteryEvidenceRow | null>(null);
  const [context, setContext] = useState<CanonicalApplicationContext | null>(null);
  const [approvedFields, setApprovedFields] = useState<string[]>([]);
  const [reviewerName, setReviewerName] = useState("");
  const [note, setNote] = useState("");
  const [applicationSearch, setApplicationSearch] = useState("");
  const [applicationResults, setApplicationResults] = useState<CanonicalApplicationContext[]>([]);
  const [isLinkSearching, setIsLinkSearching] = useState(false);
  const [isPending, startTransition] = useTransition();

  const differences = selected
    ? selected.status === "pending"
      ? buildBatteryEvidenceDifferences(selected.submitted_values, context)
      : selected.differences
    : [];

  const load = (
    next: Partial<{ page: number; status: BatteryEvidenceStatus | "all"; search: string }> = {},
  ) => {
    const nextStatus = next.status ?? status;
    const nextSearch = next.search ?? search;
    startTransition(async () => {
      try {
        setPageData(
          await getBatteryEvidencePage({
            page: next.page ?? 1,
            status: nextStatus,
            search: nextSearch,
          }),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not load battery evidence.");
      }
    });
  };

  const openEvidence = (row: BatteryEvidenceRow) => {
    setSelected(row);
    setContext(row.canonical_context);
    setApprovedFields([]);
    setNote("");
    setApplicationSearch("");
    setApplicationResults([]);
  };

  const findApplications = async () => {
    setIsLinkSearching(true);
    try {
      setApplicationResults(await searchCanonicalApplications(applicationSearch));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not search the canonical catalogue.",
      );
    } finally {
      setIsLinkSearching(false);
    }
  };

  const chooseContext = (next: CanonicalApplicationContext) => {
    setContext(next);
    setApprovedFields([]);
    setApplicationResults([]);
  };

  const toggleField = (field: string, checked: boolean) => {
    setApprovedFields((current) =>
      checked ? [...new Set([...current, field])] : current.filter((value) => value !== field),
    );
  };

  const submitReview = (action: "verify" | "dismiss" | "apply") => {
    if (!selected) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await reviewBatteryEvidence({
          evidenceId: selected.id,
          action,
          reviewerName,
          note,
          canonicalApplicationId: context?.application.id ?? null,
          approvedFields,
          expectedVehicleUpdatedAt: context?.vehicle.updated_at ?? null,
          expectedBatteryUpdatedAt: context?.battery.updated_at ?? null,
          expectedApplicationUpdatedAt: context?.application.updated_at ?? null,
        });
        toast.success(
          result.status === "applied"
            ? "Selected differences were applied to canonical data."
            : result.status === "verified"
              ? "Evidence was verified. Canonical data was not changed."
              : "Evidence was dismissed. Canonical data was not changed.",
        );
        setSelected(null);
        setApprovedFields([]);
        setNote("");
        load({ page: pageData.page });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not review battery evidence.");
      }
    });
  };

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Battery evidence review</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Compare supplier input with the normalized catalogue. Verification never changes canonical
          data. Only selected fields in an Apply action are written.
        </p>
      </div>

      {!pageData.schemaReady ? (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader>
            <CardTitle>Evidence schema upgrade pending</CardTitle>
            <CardDescription>
              The review queue will appear automatically after the production database migration
              completes.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearchIcon className="size-5" /> Evidence queue
          </CardTitle>
          <CardDescription>
            Every published observation starts here. There are no battery candidate rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              load({ page: 1 });
            }}
          >
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search source or evidence hash"
              className="sm:max-w-xl"
              disabled={!pageData.schemaReady}
            />
            <Select
              value={status}
              disabled={!pageData.schemaReady}
              onValueChange={(value) => {
                const next = value as BatteryEvidenceStatus | "all";
                setStatus(next);
                load({ page: 1, status: next });
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Filter evidence status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="verified">Verified</SelectItem>
                <SelectItem value="applied">Applied</SelectItem>
                <SelectItem value="dismissed">Dismissed</SelectItem>
                <SelectItem value="all">All evidence</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" disabled={isPending || !pageData.schemaReady}>
              {isPending ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Search
            </Button>
          </form>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Canonical application</TableHead>
                  <TableHead className="min-w-80">Differences</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Captured</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageData.rows.length ? (
                  pageData.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-72 font-medium">
                          {row.canonical_context?.label ?? "Unlinked evidence"}
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">
                          {row.canonical_application_id ?? "No application ID"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <DifferenceSummary row={row} />
                      </TableCell>
                      <TableCell>
                        <div>{display(row.source_context)}</div>
                        <div className="text-xs text-muted-foreground">
                          {display(row.source_flow)}
                        </div>
                      </TableCell>
                      <TableCell>{date(row.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => openEvidence(row)}
                        >
                          <EyeIcon /> {row.status === "pending" ? "Review" : "Inspect"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                      No evidence matches this view.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <TablePagination
            page={pageData.page}
            pageSize={pageData.pageSize}
            totalCount={pageData.totalCount}
            totalPages={Math.max(1, Math.ceil(pageData.totalCount / pageData.pageSize))}
            itemLabel="evidence row"
            onPageChange={(page) => load({ page })}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selected?.status === "pending"
                ? "Review battery evidence"
                : "Inspect battery evidence"}
            </DialogTitle>
            <DialogDescription>
              Raw supplier input is preserved. Select only differences that the evidence proves.
            </DialogDescription>
          </DialogHeader>

          {selected ? (
            <div className="space-y-6">
              <section className="space-y-3 rounded-lg border p-4">
                <div>
                  <h3 className="font-medium">Canonical application</h3>
                  <p className="text-sm text-muted-foreground">
                    {context?.label ?? "No application is linked."}
                  </p>
                </div>
                {selected.status === "pending" ? (
                  <div className="space-y-2">
                    <Label htmlFor="application-search">Find another application</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="application-search"
                        value={applicationSearch}
                        onChange={(event) => setApplicationSearch(event.target.value)}
                        placeholder="Tesla Model 3 60 kWh"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void findApplications()}
                        disabled={isLinkSearching || applicationSearch.trim().length < 2}
                      >
                        {isLinkSearching ? (
                          <Loader2Icon className="animate-spin" />
                        ) : (
                          <SearchIcon />
                        )}{" "}
                        Find
                      </Button>
                    </div>
                    {applicationResults.length ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {applicationResults.map((result) => (
                          <Button
                            key={result.application.id}
                            type="button"
                            variant="outline"
                            className="h-auto justify-start whitespace-normal py-3 text-left"
                            onClick={() => chooseContext(result)}
                          >
                            {result.label}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="space-y-3">
                <h3 className="font-medium">
                  {selected.status === "applied"
                    ? "Applied canonical changes"
                    : "Canonical versus supplier input"}
                </h3>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {selected.status === "pending" ? (
                          <TableHead className="w-12">Apply</TableHead>
                        ) : null}
                        <TableHead>Field</TableHead>
                        <TableHead>
                          {selected.status === "applied"
                            ? "Canonical value before decision"
                            : "Current canonical value"}
                        </TableHead>
                        <TableHead>
                          {selected.status === "applied" ? "Approved value" : "Supplier input"}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {differences.length ? (
                        differences.map((difference) => (
                          <TableRow key={difference.field}>
                            {selected.status === "pending" ? (
                              <TableCell>
                                <Checkbox
                                  checked={approvedFields.includes(difference.field)}
                                  onCheckedChange={(checked) =>
                                    toggleField(difference.field, checked === true)
                                  }
                                  aria-label={`Apply ${difference.label}`}
                                />
                              </TableCell>
                            ) : null}
                            <TableCell>
                              <div className="font-medium">{difference.label}</div>
                              <div className="text-xs text-muted-foreground">
                                {difference.owner}
                              </div>
                            </TableCell>
                            <TableCell className="max-w-80 break-words text-muted-foreground">
                              {display(difference.canonical)}
                            </TableCell>
                            <TableCell className="max-w-80 break-words font-medium">
                              {display(difference.submitted)}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={selected.status === "pending" ? 4 : 3}
                            className="h-24 text-center text-muted-foreground"
                          >
                            {selected.status !== "pending"
                              ? "This decision made no canonical changes."
                              : context
                                ? "No applicable differences."
                                : "Select a canonical application to calculate differences."}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </section>

              {selected.status === "pending" ? (
                <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="reviewer-name">Reviewer name</Label>
                    <Input
                      id="reviewer-name"
                      value={reviewerName}
                      onChange={(event) => setReviewerName(event.target.value)}
                      maxLength={100}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="review-note">Reason</Label>
                    <Textarea
                      id="review-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={1000}
                      placeholder="What did you verify, and from which evidence?"
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => submitReview("dismiss")}
                      disabled={isPending}
                    >
                      <XCircleIcon /> Dismiss
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => submitReview("verify")}
                      disabled={isPending}
                    >
                      <CheckCircle2Icon /> Verify evidence only
                    </Button>
                    <Button
                      type="button"
                      onClick={() => submitReview("apply")}
                      disabled={isPending || !context || approvedFields.length === 0}
                    >
                      {isPending ? <Loader2Icon className="animate-spin" /> : <CheckCircle2Icon />}{" "}
                      Apply selected differences
                    </Button>
                  </div>
                </section>
              ) : (
                <section className="rounded-lg border p-4 text-sm">
                  <div>
                    <span className="font-medium">Decision:</span> {selected.status}
                  </div>
                  <div>
                    <span className="font-medium">Reviewer:</span> {display(selected.reviewed_by)}
                  </div>
                  <div>
                    <span className="font-medium">Reason:</span> {display(selected.review_note)}
                  </div>
                  <div>
                    <span className="font-medium">Reviewed:</span> {date(selected.reviewed_at)}
                  </div>
                  {selected.status === "applied" ? (
                    <>
                      <div>
                        <span className="font-medium">Approved fields:</span>{" "}
                        {display(selected.approved_fields)}
                      </div>
                      <div>
                        <span className="font-medium">Approved values:</span>{" "}
                        {display(selected.reviewed_values)}
                      </div>
                    </>
                  ) : null}
                </section>
              )}

              {selected.status === "applied" ? (
                <details className="rounded-lg border p-4">
                  <summary className="cursor-pointer font-medium">
                    Canonical before and after snapshots
                  </summary>
                  <div className="mt-3 grid gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-sm font-medium">Before</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
                        {JSON.stringify(selected.canonical_before, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-1 text-sm font-medium">After</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
                        {JSON.stringify(selected.canonical_after, null, 2)}
                      </pre>
                    </div>
                  </div>
                </details>
              ) : null}

              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium">Raw immutable evidence</summary>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(selected.submitted_values, null, 2)}
                </pre>
              </details>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

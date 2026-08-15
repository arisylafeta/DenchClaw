"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { CrmListShell } from "@/app/components/crm/crm-list-shell";
import { DataTable } from "@/app/components/workspace/data-table";
import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/platform-admin/ui/dialog";
import { Input } from "@/app/components/platform-admin/ui/input";
import { Label } from "@/app/components/platform-admin/ui/label";
import { Textarea } from "@/app/components/platform-admin/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/platform-admin/ui/select";
import { approvePayoutCopReview, rejectPayoutCopReview } from "./actions";
import type { PayoutCopReviewListItem, PayoutCopReviewStatus } from "./types";

type Decision = "approve" | "reject";
type Filter = "open" | PayoutCopReviewStatus | "all";
type ResultFilter = PayoutCopReviewListItem["matchResult"] | "all";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(status: PayoutCopReviewStatus) {
  if (status === "approved") return <Badge>Approved</Badge>;
  if (status === "rejected") return <Badge variant="destructive">Rejected</Badge>;
  if (status === "processing") return <Badge variant="secondary">Processing</Badge>;
  if (status === "cancelled") return <Badge variant="outline">Cancelled</Badge>;
  return <Badge variant="outline">Review requested</Badge>;
}

function resultLabel(value: PayoutCopReviewListItem["matchResult"]): string {
  switch (value) {
    case "partial_match":
      return "Partial match";
    case "mismatch":
      return "Mismatch";
    case "unavailable":
      return "Service unavailable";
  }
}

export function PayoutReviewsClient({
  reviews,
}: {
  reviews: PayoutCopReviewListItem[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [selected, setSelected] = useState<PayoutCopReviewListItem | null>(null);
  const [decision, setDecision] = useState<Decision>("approve");
  const [reviewerName, setReviewerName] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    return reviews.filter((review) => {
      const matchesStatus = filter === "all"
        || (filter === "open" && ["requested", "processing"].includes(review.status))
        || review.status === filter;
      return matchesStatus && (resultFilter === "all" || review.matchResult === resultFilter);
    });
  }, [filter, resultFilter, reviews]);

  const openDecision = (review: PayoutCopReviewListItem, next: Decision) => {
    setSelected(review);
    setDecision(next);
    setReviewerName("");
    setReason("");
  };

  const submitDecision = () => {
    if (!selected) return;
    startTransition(async () => {
      const action =
        decision === "approve"
          ? approvePayoutCopReview
          : rejectPayoutCopReview;
      const result = await action({
        reviewId: selected.id,
        reviewerName,
        reason,
      });
      if (!result.success) {
        toast.error(
          decision === "approve" ? "Approval failed" : "Rejection failed",
          { description: result.error },
        );
        return;
      }

      toast.success(
        decision === "approve" ? "Payout method approved" : "Review rejected",
        {
          description:
            decision === "approve"
              ? "Stripe's bank-name result was acknowledged. No deal funds were released."
              : "The seller must correct their payout details before another review.",
        },
      );
      setSelected(null);
      router.refresh();
    });
  };

  const columns = useMemo<ColumnDef<PayoutCopReviewListItem>[]>(() => [
    {
      id: "account",
      accessorFn: (review) => `${review.accountName} ${review.accountRole} ${review.accountId}`,
      header: "Account",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.accountName}</div>
          <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {row.original.accountRole} · {row.original.accountId}
          </div>
        </div>
      ),
      size: 260,
    },
    {
      id: "bank",
      accessorFn: (review) => [review.payoutMethodLast4, review.payoutCountry, review.payoutCurrency].filter(Boolean).join(" "),
      header: "Bank",
      cell: ({ row }) => (
        <div>
          <div>Ending {row.original.payoutMethodLast4 ?? "unknown"}</div>
          <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {[row.original.payoutCountry, row.original.payoutCurrency].filter(Boolean).join(" · ") || "No corridor recorded"}
          </div>
        </div>
      ),
      size: 180,
    },
    {
      accessorKey: "matchResult",
      header: "Result",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{resultLabel(row.original.matchResult)}</div>
          {row.original.providerMessage ? (
            <div className="mt-1 truncate text-xs" style={{ color: "var(--color-text-muted)" }} title={row.original.providerMessage}>
              {row.original.providerMessage}
            </div>
          ) : null}
        </div>
      ),
      size: 280,
    },
    { accessorKey: "requestedAt", header: "Requested", cell: ({ getValue }) => formatDate(String(getValue())), size: 180 },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <div>
          {statusBadge(row.original.status)}
          {row.original.reviewedBy ? (
            <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              {row.original.reviewedBy} · {formatDate(row.original.reviewedAt)}
            </div>
          ) : null}
        </div>
      ),
      size: 200,
    },
  ], []);

  return (
    <>
      <CrmListShell title="Payout reviews" count={reviews.length}>
        <div className="h-full min-h-0">
          <DataTable
            columns={columns}
            data={filtered}
            enableGlobalFilter
            searchPlaceholder="Search payout reviews..."
            enableSorting
            enableRowSelection
            getRowId={(review) => review.id}
            pageSize={50}
            toolbarExtra={(
              <>
                <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                  <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by review status">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="requested">Requested</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="all">All statuses</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={resultFilter} onValueChange={(value) => setResultFilter(value as ResultFilter)}>
                  <SelectTrigger className="h-8 w-40 text-xs" aria-label="Filter by match result">
                    <SelectValue placeholder="Match result" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All results</SelectItem>
                    <SelectItem value="partial_match">Partial match</SelectItem>
                    <SelectItem value="mismatch">Mismatch</SelectItem>
                    <SelectItem value="unavailable">Unavailable</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
            rowActions={(review) => {
              if (review.status === "requested") {
                return [
                  { label: "Approve", icon: <CheckCircle2Icon />, onClick: () => openDecision(review, "approve") },
                  { label: "Reject", icon: <XCircleIcon />, variant: "destructive", onClick: () => openDecision(review, "reject") },
                ];
              }
              if (review.status === "processing") {
                return [{ label: "Retry approval", icon: <CheckCircle2Icon />, onClick: () => openDecision(review, "approve") }];
              }
              return [];
            }}
          />
        </div>
      </CrmListShell>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision === "approve" ? "Approve payout method?" : "Reject payout review?"}
            </DialogTitle>
            <DialogDescription>
              {decision === "approve"
                ? "This calls Stripe to acknowledge a non-matching Confirmation of Payee result. Funds sent to the wrong bank account may be unrecoverable. This action does not release any deal payout."
                : "The payout method will remain restricted. Tell the seller what must be corrected before they request another review."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reviewer-name">Operator name</Label>
              <Input
                id="reviewer-name"
                value={reviewerName}
                onChange={(event) => setReviewerName(event.target.value)}
                placeholder="Your full name"
                autoComplete="name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="review-reason">Decision reason</Label>
              <Textarea
                id="review-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="What did you verify, and why is this decision appropriate?"
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSelected(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={decision === "reject" ? "destructive" : "default"}
              onClick={submitDecision}
              disabled={isPending}
            >
              {isPending ? <Loader2Icon className="animate-spin" /> : null}
              {decision === "approve" ? "Acknowledge and approve" : "Reject review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

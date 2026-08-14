"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, LandmarkIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/platform-admin/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/platform-admin/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/platform-admin/ui/tabs";
import { Textarea } from "@/app/components/platform-admin/ui/textarea";
import { approvePayoutCopReview, rejectPayoutCopReview } from "./actions";
import type { PayoutCopReviewListItem, PayoutCopReviewStatus } from "./types";

type Decision = "approve" | "reject";
type Filter = "open" | "approved" | "rejected" | "all";

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
  const [selected, setSelected] = useState<PayoutCopReviewListItem | null>(null);
  const [decision, setDecision] = useState<Decision>("approve");
  const [reviewerName, setReviewerName] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    if (filter === "all") return reviews;
    if (filter === "open") {
      return reviews.filter((review) =>
        ["requested", "processing"].includes(review.status),
      );
    }
    return reviews.filter((review) => review.status === filter);
  }, [filter, reviews]);

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

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payout reviews</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review UK Confirmation of Payee exceptions. Approval acknowledges the bank-name result in Stripe; it never releases deal funds.
        </p>
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex items-center gap-2">
            <LandmarkIcon className="size-5" />
            <CardTitle>Confirmation of Payee queue</CardTitle>
          </div>
          <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <TabsList>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="approved">Approved</TabsTrigger>
              <TabsTrigger value="rejected">Rejected</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              No payout reviews in this view.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Bank</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((review) => (
                    <TableRow key={review.id}>
                      <TableCell>
                        <div className="font-medium">{review.accountName}</div>
                        <div className="text-xs text-muted-foreground">
                          {review.accountRole} · {review.accountId}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>Ending {review.payoutMethodLast4 ?? "unknown"}</div>
                        <div className="text-xs text-muted-foreground">
                          {[review.payoutCountry, review.payoutCurrency]
                            .filter(Boolean)
                            .join(" · ") || "No corridor recorded"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{resultLabel(review.matchResult)}</div>
                        {review.providerMessage ? (
                          <div className="mt-1 max-w-md text-xs text-muted-foreground">
                            {review.providerMessage}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{formatDate(review.requestedAt)}</TableCell>
                      <TableCell>
                        {statusBadge(review.status)}
                        {review.reviewedBy ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {review.reviewedBy} · {formatDate(review.reviewedAt)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {review.status === "requested" || review.status === "processing" ? (
                          <div className="flex justify-end gap-2">
                            {review.status === "requested" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => openDecision(review, "reject")}
                              >
                                <XCircleIcon />
                                Reject
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => openDecision(review, "approve")}
                            >
                              <CheckCircle2Icon />
                              {review.status === "processing" ? "Retry approval" : "Approve"}
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

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
    </div>
  );
}

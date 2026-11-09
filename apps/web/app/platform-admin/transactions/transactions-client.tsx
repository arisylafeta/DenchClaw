"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, Undo2Icon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { CrmListShell } from "@/app/components/crm/crm-list-shell";
import { DataTable } from "@/app/components/workspace/data-table";
import tableStyles from "@/app/components/ui/data-table.module.css";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/platform-admin/ui/select";
import { formatMoney, type TransactionRow } from "@/lib/platform-admin/transactions/contract";
import { refundAndCancelTransaction, resendCancellationEmailsAction } from "./actions";

type Filter = "all" | "open" | "paid" | "refundable" | "cancelled";

const muted = { color: "var(--color-text-muted)" } as const;

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(row: TransactionRow) {
  if (row.status === "cancelled") return <Badge variant="outline">Cancelled</Badge>;
  if (row.paymentStatus === "refunded") return <Badge variant="secondary">Refunded</Badge>;
  if (row.status === "completed") return <Badge>Completed</Badge>;
  return <Badge variant="secondary">{row.status}</Badge>;
}

export function TransactionsClient({ transactions }: { transactions: TransactionRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<TransactionRow | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(
    () =>
      transactions.filter((row) => {
        if (filter === "open") return row.status === "open";
        if (filter === "paid") return row.paymentStatus != null && row.paymentStatus !== "refunded";
        if (filter === "refundable") return row.canRefund;
        if (filter === "cancelled") return row.status === "cancelled";
        return true;
      }),
    [filter, transactions],
  );

  const submit = () => {
    if (!selected) return;
    startTransition(async () => {
      try {
        const result = await refundAndCancelTransaction({ dealId: selected.id, confirmation });
        if (!result.ok) {
          toast.error(result.stage === "database" ? "Refunded, cancellation not finished" : "Refund not made", { description: result.error, duration: 12000 });
          if (result.stage === "database") router.refresh();
          return;
        }
        const mails = [
          result.buyerEmail.sent ? "buyer emailed" : `buyer email not sent (${result.buyerEmail.error ?? result.buyerEmail.skipped})`,
          result.sellerEmail.sent ? "seller emailed" : `seller email not sent (${result.sellerEmail.error ?? result.sellerEmail.skipped})`,
        ];
        toast.success(`#${result.number} refunded and cancelled`, { description: `Stripe ${result.refundId}. ${mails.join("; ")}.`, duration: 10000 });
        setSelected(null);
        setConfirmation("");
        router.refresh();
      } catch (error) {
        toast.error("Refund failed", { description: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const resend = (row: TransactionRow) => {
    startTransition(async () => {
      const result = await resendCancellationEmailsAction(row.id);
      if (!result.ok) {
        toast.error("Resend failed", { description: result.error });
        return;
      }
      toast.success(`Emails resent for #${row.number}`, {
        description: `Buyer ${result.buyerEmail.sent ? "sent" : "not sent"}, seller ${result.sellerEmail.sent ? "sent" : "not sent"}.`,
      });
    });
  };

  const columns = useMemo<ColumnDef<TransactionRow>[]>(
    () => [
      {
        id: "transaction",
        accessorFn: (row) => `${row.number} ${row.id}`,
        header: "Transaction",
        cell: ({ row }) => (
          <div>
            <div className="font-medium">#{row.original.number}</div>
            <div className="text-xs" style={muted}>{formatDate(row.original.createdAt)}</div>
          </div>
        ),
        size: 160,
      },
      {
        id: "listing",
        accessorFn: (row) => `${row.listingTitle ?? ""} ${row.listingReference ?? ""}`,
        header: "Listing",
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.listingTitle ?? "Untitled listing"}</div>
            <div className="text-xs" style={muted}>
              {[row.original.listingReference ? `Tag ${row.original.listingReference}` : null, row.original.quantity > 1 ? `x${row.original.quantity}` : null].filter(Boolean).join(" · ") || row.original.sourceType}
            </div>
          </div>
        ),
        size: 280,
      },
      { id: "buyer", accessorFn: (row) => row.buyerName ?? "", header: "Buyer", cell: ({ row }) => row.original.buyerName ?? "—", size: 170 },
      { id: "seller", accessorFn: (row) => row.sellerName ?? "", header: "Seller", cell: ({ row }) => row.original.sellerName ?? "—", size: 170 },
      {
        id: "amount",
        accessorFn: (row) => row.amount,
        header: "Amount",
        cell: ({ row }) => formatMoney(row.original.amount, row.original.currency),
        size: 120,
      },
      {
        id: "payment",
        accessorFn: (row) => `${row.paymentStatus ?? ""} ${row.payoutStatus ?? ""}`,
        header: "Payment",
        cell: ({ row }) => (
          <div>
            <div>{row.original.paymentStatus ? row.original.paymentStatus.replace(/_/g, " ") : "Not paid"}</div>
            {row.original.payoutStatus ? <div className="text-xs" style={muted}>payout {row.original.payoutStatus.replace(/_/g, " ")}</div> : null}
          </div>
        ),
        size: 160,
      },
      { id: "status", accessorFn: (row) => row.status, header: "Status", cell: ({ row }) => statusBadge(row.original), size: 130 },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          row.original.canRefund ? (
            <Button type="button" variant="outline" size="sm" onClick={() => { setSelected(row.original); setConfirmation(""); }}>
              <Undo2Icon className="size-4" />
              {(row.original.refundedAmount ?? 0) > 0 ? "Finish cancellation" : "Refund"}
            </Button>
          ) : row.original.status === "cancelled" && (row.original.refundedAmount ?? 0) > 0 ? (
            <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => resend(row.original)}>
              Resend emails
            </Button>
          ) : null,
        size: 150,
        enableSorting: false,
        enableHiding: false,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPending],
  );

  const confirmed = selected ? confirmation.trim().replace(/^#/, "").toUpperCase() === selected.number : false;

  return (
    <>
      <CrmListShell title="Transactions" count={transactions.length}>
        <div className={`bulk-trades ${tableStyles.surface} h-full min-h-0`}>
          <DataTable
            columns={columns}
            data={filtered}
            enableGlobalFilter
            searchPlaceholder="Search transactions..."
            enableSorting
            getRowId={(row) => row.id}
            pageSize={50}
            toolbarExtra={
              <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Filter transactions">
                  <SelectValue placeholder="Filter" />
                </SelectTrigger>
                <SelectContent className={`bulk-trades ${tableStyles.menu}`}>
                  <SelectItem value="all">All transactions</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="refundable">Refundable</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </div>
      </CrmListShell>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && !isPending && setSelected(null)}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{(selected?.refundedAmount ?? 0) > 0 ? "Finish cancelling" : "Refund and cancel"} #{selected?.number}?</DialogTitle>
            <DialogDescription>
              This refunds the full payment to the buyer&apos;s card on Stripe, cancels the deal, puts the listing back on the marketplace,
              and emails the buyer and the seller. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
              <div className="font-semibold">{selected.listingTitle ?? "Untitled listing"}</div>
              <div className="mt-1 text-xs" style={muted}>
                {selected.buyerName ?? "Buyer"} bought from {selected.sellerName ?? "seller"}
              </div>
              <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
                Refund <span className="font-semibold">{formatMoney(selected.fundedAmount ?? selected.amount, selected.currency)}</span>
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="refund-confirm">Type {selected?.number} to confirm</Label>
            <Input id="refund-confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSelected(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={submit} disabled={!confirmed || isPending}>
              {isPending ? <Loader2Icon className="animate-spin" /> : null}
              Refund and cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

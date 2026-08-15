"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2Icon, MailIcon, MoreHorizontalIcon, SendIcon, Trash2Icon } from "lucide-react";
import type { ColumnDef, OnChangeFn } from "@tanstack/react-table";

import {
  CrmEmptyState,
  CrmListShell,
  CrmLoadingState,
} from "@/app/components/crm/crm-list-shell";
import { DataTable } from "@/app/components/workspace/data-table";

import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/platform-admin/ui/dropdown-menu";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/app/components/platform-admin/ui/sheet";
import { Textarea } from "@/app/components/platform-admin/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/platform-admin/ui/select";

import {
  getAccountDetails,
  deleteAccountsBulk,
  deleteAccount,
  updateAccountRole,
  updateAccountRolesBulk,
  updateAccountStatus,
  updateAccountStatusesBulk,
  sendEmailToAccounts,
} from "./actions";
import type { AccountDetails } from "./actions";
import type { Enums } from "@/lib/platform-admin/database.types";

type AccountRole = Enums<"account_role">;
type AccountStatus = Enums<"account_status">;
type AccountType = Enums<"account_type">;

type Account = {
  id: string;
  name: string;
  email: string | null;
  role: AccountRole;
  account_type: AccountType;
  status: AccountStatus;
  created_at: string;
  display_name: string | null;
  location: string | null;
};

type DeleteTarget =
  | { kind: "single"; account: Account }
  | { kind: "bulk"; accountIds: string[]; count: number }
  | null;

function roleBadgeClass(role: AccountRole): string {
  switch (role) {
    case "buyer":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "supplier":
      return "bg-green-100 text-green-700 border-green-200";
    case "recycler":
      return "bg-purple-100 text-purple-700 border-purple-200";
  }
}

function statusBadgeClass(status: AccountStatus): string {
  switch (status) {
    case "active":
    case "approved":
      return "bg-green-100 text-green-700 border-green-200";
    case "pending":
    case "waitlist":
      return "bg-yellow-100 text-yellow-700 border-yellow-200";
    case "suspended":
      return "bg-red-100 text-red-700 border-red-200";
    case "archived":
      return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AccountActions({
  account,
  isPending,
  onStatusAction,
  onRoleAction,
  onDeleteAction,
  onEmailAction,
}: {
  account: Account;
  isPending: boolean;
  onStatusAction: (accountId: string, status: AccountStatus) => void;
  onRoleAction: (accountId: string, role: AccountRole) => void;
  onDeleteAction: (account: Account) => void;
  onEmailAction: (account: Account) => void;
}) {
  const { status, id } = account;

  const statusActions: { label: string; targetStatus: AccountStatus }[] = [];

  if (status === "pending" || status === "waitlist") {
    statusActions.push({ label: "Approve", targetStatus: "approved" });
  }
  if (status === "approved") {
    statusActions.push({ label: "Activate", targetStatus: "active" });
  }
  if (status === "active" || status === "approved") {
    statusActions.push({ label: "Suspend", targetStatus: "suspended" });
  }
  if (status === "suspended") {
    statusActions.push({ label: "Reactivate", targetStatus: "active" });
  }
  if (status === "approved" || status === "active" || status === "suspended") {
    statusActions.push({ label: "Mark as Pending", targetStatus: "pending" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <MoreHorizontalIcon className="size-4" />
          <span className="sr-only">Open actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {statusActions.map(({ label, targetStatus }) => (
          <DropdownMenuItem
            key={targetStatus}
            onSelect={() => onStatusAction(id, targetStatus)}
            disabled={isPending}
            variant={targetStatus === "suspended" ? "destructive" : "default"}
          >
            {label}
          </DropdownMenuItem>
        ))}
        {statusActions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => onRoleAction(id, "buyer")} disabled={isPending || account.role === "buyer"}>
          Set role to Buyer
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRoleAction(id, "supplier")} disabled={isPending || account.role === "supplier"}>
          Set role to Supplier
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRoleAction(id, "recycler")} disabled={isPending || account.role === "recycler"}>
          Set role to Recycler
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onEmailAction(account)} disabled={isPending}>
          <MailIcon className="size-3.5 mr-1.5 text-muted-foreground" />
          Send email
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onDeleteAction(account)}
          variant="destructive"
          disabled={isPending}
        >
          <Trash2Icon className="size-3.5 mr-1.5" />
          Delete account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Compose Sheet ────────────────────────────────────────────────────────────

interface ComposeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipients: Account[];
  onSent: () => void;
}

interface AccountDetailsViewProps {
  onBack: () => void;
  isLoading: boolean;
  error: string | null;
  details: AccountDetails | null;
}

function formatAddress(value: unknown): string {
  const addresses = Array.isArray(value) ? value : value ? [value] : [];
  const formatted = addresses.flatMap((address) => {
    if (!address || typeof address !== "object") return [];
    const record = address as Record<string, unknown>;
    const parts = [
      record.line1,
      record.line2,
      record.city,
      record.region,
      record.postcode ?? record.postal_code,
      record.country,
    ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    return parts.length > 0 ? [parts.join(", ")] : [];
  });
  return formatted.join(" · ") || "—";
}

type MetadataRow = { id: string; source: string; field: string; value: string };

function metadataRows(source: string, value: unknown): MetadataRow[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([field, fieldValue]) => ({
    id: `${source}:${field}`,
    source,
    field,
    value: typeof fieldValue === "string"
      ? fieldValue
      : fieldValue == null
        ? "—"
        : JSON.stringify(fieldValue, null, 2),
  }));
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm" style={{ color: "var(--color-text)" }}>
        {value || "—"}
      </dd>
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
        {title}
      </h2>
      <dl
        className="grid gap-x-6 gap-y-5 rounded-2xl border p-5 sm:grid-cols-2"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        {children}
      </dl>
    </section>
  );
}

function DetailStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded-2xl border px-4 py-3"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="text-[11px] font-medium" style={{ color: "var(--color-text-muted)" }}>{label}</div>
      <div className="mt-1 truncate text-lg font-semibold" style={{ color: "var(--color-text)" }}>{value}</div>
    </div>
  );
}

type AccountDetailTab = "overview" | "members" | "platform";

function AccountDetailsView({
  onBack,
  isLoading,
  error,
  details,
}: AccountDetailsViewProps) {
  const [tab, setTab] = useState<AccountDetailTab>("overview");
  const memberColumns = useMemo<ColumnDef<AccountDetails["members"][number]>[]>(() => [
    {
      id: "name",
      accessorFn: (member) => member.full_name ?? "Unnamed user",
      header: "Name",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.full_name ?? "Unnamed user"}</div>
          {row.original.is_primary ? (
            <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>Primary contact</div>
          ) : null}
        </div>
      ),
    },
    { accessorKey: "email", header: "Email", cell: ({ getValue }) => String(getValue() ?? "—") },
    { accessorKey: "phone_number", header: "Phone", cell: ({ getValue }) => String(getValue() ?? "—") },
    { accessorKey: "membership_role", header: "Membership" },
    { accessorKey: "position", header: "Position", cell: ({ getValue }) => String(getValue() ?? "—") },
    { accessorKey: "status", header: "Status", cell: ({ getValue }) => capitalize(String(getValue() ?? "—")) },
    { accessorKey: "joined_at", header: "Joined", cell: ({ getValue }) => formatDate(String(getValue())) },
    { accessorKey: "user_id", header: "User ID", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
  ], []);

  const profileRows = useMemo(() => [
    ...metadataRows("Public profile", details?.publicProfile?.public_fields_json),
    ...metadataRows("Operations", details?.privateProfile?.ops_json),
  ], [details]);

  const address = details
    ? (() => {
        const addresses = formatAddress(details.privateProfile?.addresses_json);
        return addresses === "—" ? formatAddress(details.privateProfile?.billing_address) : addresses;
      })()
    : "—";

  const profileColumns = useMemo<ColumnDef<MetadataRow>[]>(() => [
    { accessorKey: "source", header: "Source", size: 160 },
    { accessorKey: "field", header: "Field", size: 220 },
    {
      accessorKey: "value",
      header: "Value",
      cell: ({ getValue }) => <span className="whitespace-pre-wrap break-words font-mono text-xs">{String(getValue())}</span>,
      enableSorting: false,
    },
  ], []);

  if (isLoading && !details) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <header className="shrink-0 border-b px-6 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[12px] hover:underline" style={{ color: "var(--color-text-muted)" }} aria-label="Back to Accounts">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6" /></svg>
            Accounts
          </button>
        </header>
        <CrmLoadingState label="Loading account…" />
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <CrmEmptyState
          title="Couldn’t load this account"
          description={error ?? "The account may no longer exist."}
          cta={<Button type="button" variant="outline" size="sm" onClick={onBack}>Back to Accounts</Button>}
        />
      </div>
    );
  }

  const tabs: Array<{ id: AccountDetailTab; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    { id: "members", label: "Members", count: details.members.length },
    { id: "platform", label: "Platform data", count: profileRows.length },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-background)" }}>
      <header
        className="shrink-0 px-6 pt-4"
        style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-background)" }}
      >
        <div className="mb-3 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1 hover:underline" aria-label="Back to Accounts">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6" /></svg>
            Accounts
          </button>
        </div>
        <div className="flex items-start gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl border"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-muted)" }}
          >
            <Building2Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-instrument truncate text-2xl tracking-tight" style={{ color: "var(--color-text)" }}>{details.account.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]" style={{ color: "var(--color-text-muted)" }}>
              <Badge variant="outline" className={roleBadgeClass(details.account.role)}>{humanize(details.account.role)}</Badge>
              <Badge variant="outline" className={statusBadgeClass(details.account.status)}>{humanize(details.account.status)}</Badge>
              <span>{humanize(details.account.account_type)}</span>
              {details.publicProfile?.website_url ? (
                <a href={details.publicProfile.website_url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                  {details.publicProfile.website_url.replace(/^https?:\/\//, "")}
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <nav className="mt-5 flex items-center gap-4 -mb-px" aria-label="Account details" role="tablist">
          {tabs.map((item) => {
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className="relative flex items-center gap-1.5 px-1 py-2 text-[13px] font-medium transition-colors"
                style={{ color: active ? "var(--color-text)" : "var(--color-text-muted)", borderBottom: active ? "2px solid var(--color-text)" : "2px solid transparent" }}
              >
                {item.label}
                {typeof item.count === "number" && item.count > 0 ? (
                  <span className="rounded-full px-1.5 text-[10px]" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>{item.count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="min-h-0 flex-1">
        {tab === "overview" ? (
          <div className="mx-auto h-full w-full max-w-4xl space-y-7 overflow-y-auto px-6 py-6" role="tabpanel">
            <section>
              <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>At a glance</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <DetailStat label="Members" value={details.members.length} />
                <DetailStat label="Role" value={humanize(details.account.role)} />
                <DetailStat label="Status" value={humanize(details.account.status)} />
                <DetailStat label="Stripe" value={humanize(details.account.stripe_connect_status)} />
              </div>
            </section>

            {details.publicProfile?.about ? (
              <section>
                <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>About</h2>
                <p className="max-w-3xl text-[13px] leading-6" style={{ color: "var(--color-text)" }}>{details.publicProfile.about}</p>
              </section>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-2">
              <DetailCard title="Organisation">
              <DetailField label="Display name" value={details.publicProfile?.display_name ?? details.account.name} />
              <DetailField label="Sector" value={details.account.sector ? humanize(details.account.sector) : "—"} />
              <DetailField label="Company number" value={details.privateProfile?.company_number ?? "—"} />
              <DetailField label="Tax registration" value={details.privateProfile?.tax_registered ? details.privateProfile.tax_id ?? "Registered" : "Not registered"} />
              <DetailField label="Address" value={address} />
              <DetailField label="SEO slug" value={details.publicProfile?.seo_slug ?? "—"} />
              </DetailCard>
              <DetailCard title="Payments and audit">
              <DetailField label="Stripe Connect" value={humanize(details.account.stripe_connect_status)} />
              <DetailField label="Stripe account ID" value={details.account.stripe_connect_account_id ? <span className="font-mono text-xs">{details.account.stripe_connect_account_id}</span> : "—"} />
              <DetailField label="Stripe onboarded" value={details.account.stripe_connect_onboarded_at ? formatDateTime(details.account.stripe_connect_onboarded_at) : "—"} />
              <DetailField label="Created" value={formatDateTime(details.account.created_at)} />
              <DetailField label="Updated" value={formatDateTime(details.account.updated_at)} />
              <DetailField label="Account ID" value={<span className="font-mono text-xs">{details.account.id}</span>} />
              </DetailCard>
            </div>
          </div>
        ) : null}

        {tab === "members" ? (
          <div className="h-full min-h-0 p-4" role="tabpanel">
            <DataTable
              columns={memberColumns}
              data={details.members}
              enableGlobalFilter
              searchPlaceholder="Search members..."
              enableSorting
              enableRowSelection
              stickyFirstColumn={false}
              getRowId={(member) => member.user_id}
              pageSize={20}
            />
          </div>
        ) : null}

        {tab === "platform" ? (
          profileRows.length > 0 ? (
            <div className="h-full min-h-0 p-4" role="tabpanel">
              <DataTable
                columns={profileColumns}
                data={profileRows}
                enableGlobalFilter
                searchPlaceholder="Search profile fields..."
                enableSorting
                stickyFirstColumn={false}
                getRowId={(row) => row.id}
                pageSize={20}
              />
            </div>
          ) : <CrmEmptyState title="No platform fields" description="This account has no public profile or operations fields." />
        ) : null}
      </div>
    </div>
  );
}

function ComposeSheet({ open, onOpenChange, recipients, onSent }: ComposeSheetProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isSending, startSending] = useTransition();

  function handleSend() {
    startSending(async () => {
      const result = await sendEmailToAccounts({
        accountIds: recipients.map((r) => r.id),
        subject,
        body,
      });

      if (result.error && result.sent === 0) {
        toast.error(result.error);
        return;
      }

      if (result.failed > 0) {
        toast.warning(
          `Sent to ${result.sent} account${result.sent !== 1 ? "s" : ""}. ${result.failed} failed (no email on file).`,
        );
      } else {
        toast.success(
          `Email sent to ${result.sent} account${result.sent !== 1 ? "s" : ""}.`,
        );
      }

      setSubject("");
      setBody("");
      onOpenChange(false);
      onSent();
    });
  }

  const recipientLabel =
    recipients.length === 1
      ? recipients[0].name
      : `${recipients.length} accounts`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle>Send email</SheetTitle>
          <SheetDescription>
            To: <span className="font-medium text-[var(--color-text)]">{recipientLabel}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 flex flex-col gap-4 py-4 overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              placeholder="Enter subject…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={isSending}
            />
          </div>

          <div className="space-y-1.5 flex-1 flex flex-col">
            <Label htmlFor="email-body">Message</Label>
            <Textarea
              id="email-body"
              placeholder="Type your message here…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={isSending}
              className="flex-1 min-h-48 resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Plain text — paragraph breaks are preserved. The email will be
              sent using the ReBattery branded layout.
            </p>
          </div>
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={isSending || !subject.trim() || !body.trim()}
          >
            <SendIcon className="size-4 mr-1.5" />
            {isSending ? "Sending…" : "Send"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main client component ────────────────────────────────────────────────────

export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [roleFilter, setRoleFilter] = useState<"all" | AccountRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | AccountStatus>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | AccountType>("all");
  const [isPending, startTransition] = useTransition();
  const [isDetailsPending, startDetailsTransition] = useTransition();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetRecipients, setSheetRecipients] = useState<Account[]>([]);
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const detailsRequestId = useRef(0);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");

  const filtered = useMemo(
    () => accounts.filter((account) =>
      (roleFilter === "all" || account.role === roleFilter) &&
      (statusFilter === "all" || account.status === statusFilter) &&
      (typeFilter === "all" || account.account_type === typeFilter)
    ),
    [accounts, roleFilter, statusFilter, typeFilter],
  );

  // Bulk actions apply only to rows visible under the current filters.
  const filteredIds = new Set(filtered.map((a) => a.id));
  const activeSelected = new Set([...selectedIds].filter((id) => filteredIds.has(id)));
  const rowSelection = Object.fromEntries([...activeSelected].map((id) => [id, true]));
  const handleRowSelectionChange: OnChangeFn<Record<string, boolean>> = (updater) => {
    setSelectedIds((previous) => {
      const currentVisible = Object.fromEntries(
        filtered
          .filter((account) => previous.has(account.id))
          .map((account) => [account.id, true]),
      );
      const nextVisible = typeof updater === "function" ? updater(currentVisible) : updater;
      const next = new Set(previous);
      filtered.forEach((account) => next.delete(account.id));
      Object.entries(nextVisible).forEach(([id, selected]) => {
        if (selected) next.add(id);
      });
      return next;
    });
  };

  function openComposeFor(recipients: Account[]) {
    setSheetRecipients(recipients);
    setSheetOpen(true);
  }

  function handleStatusAction(accountId: string, status: AccountStatus) {
    startTransition(async () => {
      const result = await updateAccountStatus(accountId, status);
      if (result.success) {
        if (status === "approved") {
          if (result.emailSent) {
            toast.success("Account approved — approval email sent.");
          } else {
            toast.warning(
              `Account approved, but email failed: ${result.emailError ?? "unknown error"}.`,
            );
          }
        } else {
          toast.success(`Account ${status} successfully.`);
        }
        router.refresh();
      } else {
        toast.error(result.error ?? "Failed to update account.");
      }
    });
  }

  function handleRoleAction(accountId: string, role: AccountRole) {
    startTransition(async () => {
      const result = await updateAccountRole(accountId, role);
      if (!result.success) {
        toast.error(result.error ?? "Failed to update account role.");
        return;
      }

      if (result.unchanged) {
        toast.message(`Account is already ${role}.`);
        return;
      }

      toast.success(`Account role changed to ${role}.`);
      router.refresh();
    });
  }

  function handleDeleteAction(account: Account) {
    setDeleteTarget({ kind: "single", account });
    setDeleteConfirmationText("");
    setDeleteDialogOpen(true);
  }

  function handleBulkEmail() {
    const recipients = filtered.filter((a) => activeSelected.has(a.id));
    openComposeFor(recipients);
  }

  function handleBulkStatusChange(status: AccountStatus) {
    const accountIds = [...activeSelected];
    startTransition(async () => {
      const result = await updateAccountStatusesBulk(accountIds, status);
      if (!result.success) {
        toast.error(result.error ?? "Failed to update selected accounts.");
        return;
      }

      const label = status.charAt(0).toUpperCase() + status.slice(1);
      const count = result.updatedAccounts ?? accountIds.length;

      if (status === "approved" && (result.emailSent != null || result.emailFailed != null)) {
        const parts: string[] = [`${label} ${count} account${count === 1 ? "" : "s"}.`];
        if (result.emailSent) parts.push(`${result.emailSent} approval email${result.emailSent === 1 ? "" : "s"} sent.`);
        if (result.emailFailed) parts.push(`${result.emailFailed} failed (no email on file).`);
        toast.success(parts.join(" "));
      } else {
        toast.success(`${label} ${count} account${count === 1 ? "" : "s"}.`);
      }
      setSelectedIds(new Set());
      router.refresh();
    });
  }

  function handleBulkRoleChange(role: AccountRole) {
    const accountIds = [...activeSelected];
    startTransition(async () => {
      const result = await updateAccountRolesBulk(accountIds, role);
      if (!result.success) {
        toast.error(result.error ?? "Failed to update selected account roles.");
        return;
      }

      toast.success(
        `Changed role to ${role} for ${result.updatedAccounts ?? accountIds.length} account${
          (result.updatedAccounts ?? accountIds.length) === 1 ? "" : "s"
        }.`,
      );
      setSelectedIds(new Set());
      router.refresh();
    });
  }

  function handleBulkDelete() {
    const accountIds = [...activeSelected];
    if (accountIds.length === 0) {
      return;
    }

    setDeleteTarget({ kind: "bulk", accountIds, count: accountIds.length });
    setDeleteConfirmationText("");
    setDeleteDialogOpen(true);
  }

  const expectedDeleteConfirmation =
    deleteTarget?.kind === "single"
      ? deleteTarget.account.name
      : deleteTarget?.kind === "bulk"
        ? `DELETE ${deleteTarget.count}`
        : "";

  function handleConfirmDelete() {
    if (!deleteTarget) {
      return;
    }

    if (deleteConfirmationText.trim() !== expectedDeleteConfirmation) {
      toast.error("Confirmation text did not match.");
      return;
    }

    startTransition(async () => {
      if (deleteTarget.kind === "single") {
        const result = await deleteAccount(deleteTarget.account.id);
        if (!result.success) {
          toast.error(result.error ?? "Failed to delete account.");
          return;
        }

        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.account.id);
          return next;
        });
        toast.success("Account deleted.");
      } else {
        const result = await deleteAccountsBulk(deleteTarget.accountIds);
        if (!result.success) {
          toast.error(result.error ?? "Failed to delete selected accounts.");
          return;
        }

        const deletedCount = result.deletedAccounts ?? deleteTarget.count;
        toast.success(
          `Deleted ${deletedCount} account${deletedCount === 1 ? "" : "s"}.`,
        );
        setSelectedIds(new Set());
      }

      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      setDeleteConfirmationText("");
      router.refresh();
    });
  }

  function handleOpenAccountDetails(accountId: string) {
    const requestId = ++detailsRequestId.current;
    setDetailsSheetOpen(true);
    setDetailsError(null);
    setDetails(null);

    startDetailsTransition(async () => {
      try {
        const result = await getAccountDetails(accountId);
        if (requestId !== detailsRequestId.current) return;
        if (!result.success) {
          setDetailsError(result.error ?? "Failed to load account details.");
          return;
        }

        setDetails(result.data ?? null);
      } catch (error) {
        if (requestId !== detailsRequestId.current) return;
        setDetailsError(error instanceof Error ? error.message : "Failed to load account details.");
      }
    });
  }

  const accountTypes = [...new Set(accounts.map((account) => account.account_type))];
  const accountStatuses = [...new Set(accounts.map((account) => account.status))];
  const columns = useMemo<ColumnDef<Account>[]>(() => [
    {
      id: "name",
      accessorFn: (account) => [account.name, account.display_name].filter(Boolean).join(" "),
      header: "Name",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          {row.original.display_name ? (
            <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {row.original.display_name}
            </div>
          ) : null}
        </div>
      ),
      size: 230,
    },
    { accessorKey: "email", header: "Email", cell: ({ getValue }) => String(getValue() ?? "—"), size: 230 },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => (
        <Badge variant="outline" className={roleBadgeClass(row.original.role)}>
          {capitalize(row.original.role)}
        </Badge>
      ),
      size: 120,
    },
    { accessorKey: "account_type", header: "Type", cell: ({ getValue }) => capitalize(String(getValue())), size: 120 },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant="outline" className={statusBadgeClass(row.original.status)}>
          {capitalize(row.original.status)}
        </Badge>
      ),
      size: 130,
    },
    { accessorKey: "location", header: "Location", cell: ({ getValue }) => String(getValue() ?? "—"), size: 220 },
    { accessorKey: "created_at", header: "Joined", cell: ({ getValue }) => formatDate(String(getValue())), size: 140 },
    {
      id: "account_actions",
      header: "",
      cell: ({ row }) => (
        <AccountActions
          account={row.original}
          isPending={isPending}
          onStatusAction={handleStatusAction}
          onRoleAction={handleRoleAction}
          onDeleteAction={handleDeleteAction}
          onEmailAction={(account) => openComposeFor([account])}
        />
      ),
      size: 64,
      enableSorting: false,
      enableHiding: false,
    },
  // The action handlers only close over stable React setters, server actions, and the router.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [isPending]);

  if (detailsSheetOpen) {
    return (
      <AccountDetailsView
        onBack={() => {
          detailsRequestId.current += 1;
          setDetailsSheetOpen(false);
          setDetails(null);
          setDetailsError(null);
        }}
        isLoading={isDetailsPending}
        error={detailsError}
        details={details}
      />
    );
  }

  return (
    <>
      <CrmListShell title="Accounts" count={accounts.length}>
        <div className="h-full min-h-0">
          <DataTable
            columns={columns}
            data={filtered}
            enableGlobalFilter
            searchPlaceholder="Search accounts..."
            enableSorting
            enableRowSelection
            rowSelection={rowSelection}
            onRowSelectionChange={handleRowSelectionChange}
            onRowClick={(account) => handleOpenAccountDetails(account.id)}
            getRowId={(account) => account.id}
            pageSize={50}
            onRefresh={() => router.refresh()}
            toolbarExtra={(
              <>
                <Select
                  value={roleFilter}
                  onValueChange={(value) => {
                    setRoleFilter(value as "all" | AccountRole);
                    setSelectedIds(new Set());
                  }}
                >
                  <SelectTrigger className="h-8 w-32 text-xs" aria-label="Filter by role">
                    <SelectValue placeholder="All roles" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All roles</SelectItem>
                    <SelectItem value="buyer">Buyers</SelectItem>
                    <SelectItem value="supplier">Suppliers</SelectItem>
                    <SelectItem value="recycler">Recyclers</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => {
                    setStatusFilter(value as "all" | AccountStatus);
                    setSelectedIds(new Set());
                  }}
                >
                  <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by status">
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {accountStatuses.map((status) => (
                      <SelectItem key={status} value={status}>{capitalize(status)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={typeFilter}
                  onValueChange={(value) => {
                    setTypeFilter(value as "all" | AccountType);
                    setSelectedIds(new Set());
                  }}
                >
                  <SelectTrigger className="h-8 w-32 text-xs" aria-label="Filter by type">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {accountTypes.map((type) => (
                      <SelectItem key={type} value={type}>{capitalize(type)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            bulkActions={activeSelected.size > 0 ? (
              <>
              <Button variant="outline" size="sm" onClick={handleBulkEmail}>
                <MailIcon className="size-4" />
                Email
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isPending}>
                    Bulk actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => handleBulkStatusChange("approved")}>
                    Approve selected
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleBulkStatusChange("active")}>
                    Activate selected
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleBulkStatusChange("suspended")} variant="destructive">
                    Suspend selected
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleBulkStatusChange("pending")}>
                    Mark selected as pending
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => handleBulkRoleChange("buyer")}>
                    Set selected role to Buyer
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleBulkRoleChange("supplier")}>
                    Set selected role to Supplier
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleBulkRoleChange("recycler")}>
                    Set selected role to Recycler
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleBulkDelete} variant="destructive">
                    <Trash2Icon className="size-3.5 mr-1.5" />
                    Delete selected
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </>
            ) : null}
          />
        </div>
      </CrmListShell>

      <ComposeSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        recipients={sheetRecipients}
        onSent={() => setSelectedIds(new Set())}
      />

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setDeleteTarget(null);
            setDeleteConfirmationText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.kind === "single" ? "Delete account" : "Delete selected accounts"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === "single"
                ? "This will permanently delete the account and all related records through database cascade rules."
                : "This will permanently delete all selected accounts and related records through database cascade rules."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="delete-confirmation-input">
              Type <span className="font-mono">{expectedDeleteConfirmation}</span> to confirm
            </Label>
            <Input
              id="delete-confirmation-input"
              value={deleteConfirmationText}
              onChange={(event) => setDeleteConfirmationText(event.target.value)}
              placeholder={expectedDeleteConfirmation}
              disabled={isPending}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={isPending || deleteConfirmationText.trim() !== expectedDeleteConfirmation}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

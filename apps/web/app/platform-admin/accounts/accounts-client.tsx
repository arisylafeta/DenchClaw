"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MailIcon, MoreHorizontalIcon, SendIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Checkbox } from "@/app/components/platform-admin/ui/checkbox";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/platform-admin/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/platform-admin/ui/tabs";
import { Textarea } from "@/app/components/platform-admin/ui/textarea";

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

type Tab = "all" | AccountRole;

type DeleteTarget =
  | { kind: "single"; account: Account }
  | { kind: "bulk"; accountIds: string[]; count: number }
  | null;

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "buyer", label: "Buyers" },
  { value: "supplier", label: "Suppliers" },
  { value: "recycler", label: "Recyclers" },
];

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

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to render JSON";
  }
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

interface AccountDetailsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading: boolean;
  error: string | null;
  details: AccountDetails | null;
}

function AccountDetailsSheet({
  open,
  onOpenChange,
  isLoading,
  error,
  details,
}: AccountDetailsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle>Account details</SheetTitle>
          <SheetDescription>
            Public + private data connected to this account.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-5">
          {isLoading && (
            <div className="text-sm text-muted-foreground">Loading account details…</div>
          )}

          {!isLoading && error && (
            <div className="text-sm text-[var(--color-error)]">{error}</div>
          )}

          {!isLoading && !error && details && (
            <>
              <section className="rounded-lg border p-4 space-y-2">
                <h3 className="text-sm font-semibold">Account</h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Name</dt>
                    <dd>{details.account.name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Role</dt>
                    <dd>{capitalize(details.account.role)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>{capitalize(details.account.account_type)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{capitalize(details.account.status)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Sector</dt>
                    <dd>{details.account.sector ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Stripe connect status</dt>
                    <dd>{details.account.stripe_connect_status}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Created</dt>
                    <dd>{formatDateTime(details.account.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatDateTime(details.account.updated_at)}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Account ID</dt>
                    <dd className="font-mono text-xs break-all">{details.account.id}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Stripe account ID</dt>
                    <dd>{details.account.stripe_connect_account_id ?? "—"}</dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-lg border p-4 space-y-2">
                <h3 className="text-sm font-semibold">Public profile</h3>
                {details.publicProfile ? (
                  <>
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Display name</dt>
                        <dd>{details.publicProfile.display_name}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Website</dt>
                        <dd>{details.publicProfile.website_url ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">SEO slug</dt>
                        <dd>{details.publicProfile.seo_slug ?? "—"}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">About</dt>
                        <dd>{details.publicProfile.about ?? "—"}</dd>
                      </div>
                    </dl>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">public_fields_json</p>
                      <pre className="max-h-44 overflow-auto rounded-xl bg-[var(--color-surface-hover)] p-3 text-xs">
                        {formatJson(details.publicProfile.public_fields_json)}
                      </pre>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No public profile record found.</p>
                )}
              </section>

              <section className="rounded-lg border p-4 space-y-2">
                <h3 className="text-sm font-semibold">Private profile</h3>
                {details.privateProfile ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Tax registered</dt>
                        <dd>{details.privateProfile.tax_registered ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Tax ID</dt>
                        <dd>{details.privateProfile.tax_id ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Company number</dt>
                        <dd>{details.privateProfile.company_number ?? "—"}</dd>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">billing_address</p>
                      <pre className="max-h-40 overflow-auto rounded-xl bg-[var(--color-surface-hover)] p-3 text-xs">
                        {formatJson(details.privateProfile.billing_address)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">addresses_json</p>
                      <pre className="max-h-40 overflow-auto rounded-xl bg-[var(--color-surface-hover)] p-3 text-xs">
                        {formatJson(details.privateProfile.addresses_json)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">ops_json</p>
                      <pre className="max-h-40 overflow-auto rounded-xl bg-[var(--color-surface-hover)] p-3 text-xs">
                        {formatJson(details.privateProfile.ops_json)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No private profile record found.</p>
                )}
              </section>

              <section className="rounded-lg border p-4 space-y-3">
                <h3 className="text-sm font-semibold">Members</h3>
                {details.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No membership records found.</p>
                ) : (
                  <div className="space-y-2">
                    {details.members.map((member) => (
                      <div key={member.user_id} className="rounded border p-3 text-sm space-y-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium">{member.full_name ?? "Unnamed user"}</p>
                          {member.is_primary && (
                            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                              Primary
                            </Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground">Email: {member.email ?? "—"}</p>
                        <p className="text-muted-foreground">Role: {member.membership_role}</p>
                        <p className="text-muted-foreground">Status: {member.status ?? "—"}</p>
                        <p className="text-muted-foreground">Phone: {member.phone_number ?? "—"}</p>
                        <p className="text-muted-foreground">Position: {member.position ?? "—"}</p>
                        <p className="text-muted-foreground">Joined: {formatDateTime(member.joined_at)}</p>
                        <p className="font-mono text-xs text-muted-foreground break-all">
                          User ID: {member.user_id}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
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
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [isPending, startTransition] = useTransition();
  const [isDetailsPending, startDetailsTransition] = useTransition();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetRecipients, setSheetRecipients] = useState<Account[]>([]);
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");

  const filtered =
    activeTab === "all"
      ? accounts
      : accounts.filter((a) => a.role === activeTab);

  // Keep selection in sync when tab changes (only keep ids that are in filtered)
  const filteredIds = new Set(filtered.map((a) => a.id));
  const activeSelected = new Set([...selectedIds].filter((id) => filteredIds.has(id)));
  const allSelected = filtered.length > 0 && filtered.every((a) => activeSelected.has(a.id));
  const someSelected = activeSelected.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filtered.forEach((a) => next.delete(a.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filtered.forEach((a) => next.add(a.id));
        return next;
      });
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  function handleBulkMarkPending() {
    const accountIds = [...activeSelected];
    startTransition(async () => {
      const result = await updateAccountStatusesBulk(accountIds, "pending");
      if (!result.success) {
        toast.error(result.error ?? "Failed to update selected accounts.");
        return;
      }

      toast.success(
        `Marked ${result.updatedAccounts ?? accountIds.length} account${
          (result.updatedAccounts ?? accountIds.length) === 1 ? "" : "s"
        } as pending.`,
      );
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
    setDetailsSheetOpen(true);
    setDetailsError(null);
    setDetails(null);

    startDetailsTransition(async () => {
      const result = await getAccountDetails(accountId);
      if (!result.success) {
        setDetailsError(result.error ?? "Failed to load account details.");
        return;
      }

      setDetails(result.data ?? null);
    });
  }

  return (
    <>
      <div className="space-y-6 p-6 lg:p-8">
        {/* Page heading */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-instrument text-3xl tracking-tight text-[var(--color-text)]">Accounts</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {accounts.length} account{accounts.length !== 1 ? "s" : ""} total
            </p>
          </div>

          {activeSelected.size > 0 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleBulkEmail}>
                <MailIcon className="size-4 mr-1.5" />
                Email {activeSelected.size} selected
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
            </div>
          )}
        </div>

        {/* Tabs + table */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Tab)}
        >
          <TabsList>
            {TABS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          {TABS.map(({ value }) => (
            <TabsContent key={value} value={value}>
              <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4 w-10">
                        <Checkbox
                          checked={allSelected ? true : someSelected ? "indeterminate" : false}
                          onCheckedChange={toggleAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Joined</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={9}
                          className="text-center text-muted-foreground py-10"
                        >
                          No accounts found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filtered.map((account) => (
                        <TableRow
                          key={account.id}
                          className={isPending ? "opacity-60" : undefined}
                          data-selected={activeSelected.has(account.id) ? "true" : undefined}
                        >
                          {/* Checkbox */}
                          <TableCell className="pl-4">
                            <Checkbox
                              checked={activeSelected.has(account.id)}
                              onCheckedChange={() => toggleOne(account.id)}
                              aria-label={`Select ${account.name}`}
                            />
                          </TableCell>

                          {/* Name */}
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => handleOpenAccountDetails(account.id)}
                              className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
                            >
                              {account.name}
                            </button>
                            {account.display_name && (
                              <div className="text-xs text-muted-foreground">
                                {account.display_name}
                              </div>
                            )}
                          </TableCell>

                          {/* Email */}
                          <TableCell>
                            <span className={account.email ? "text-muted-foreground text-sm" : "text-muted-foreground"}>
                              {account.email ?? "—"}
                            </span>
                          </TableCell>

                          {/* Role */}
                          <TableCell>
                            <Badge
                              className={roleBadgeClass(account.role)}
                              variant="outline"
                            >
                              {capitalize(account.role)}
                            </Badge>
                          </TableCell>

                          {/* Type */}
                          <TableCell className="text-muted-foreground text-sm">
                            {capitalize(account.account_type)}
                          </TableCell>

                          {/* Status */}
                          <TableCell>
                            <Badge
                              className={statusBadgeClass(account.status)}
                              variant="outline"
                            >
                              {capitalize(account.status)}
                            </Badge>
                          </TableCell>

                          {/* Location */}
                          <TableCell className="text-muted-foreground text-sm">
                            {account.location ?? "—"}
                          </TableCell>

                          {/* Joined */}
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDate(account.created_at)}
                          </TableCell>

                          {/* Actions */}
                          <TableCell className="pr-4">
                            <AccountActions
                              account={account}
                              isPending={isPending}
                              onStatusAction={handleStatusAction}
                              onRoleAction={handleRoleAction}
                              onDeleteAction={handleDeleteAction}
                              onEmailAction={(a) => openComposeFor([a])}
                            />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>

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

      <AccountDetailsSheet
        open={detailsSheetOpen}
        onOpenChange={setDetailsSheetOpen}
        isLoading={isDetailsPending}
        error={detailsError}
        details={details}
      />
    </>
  );
}

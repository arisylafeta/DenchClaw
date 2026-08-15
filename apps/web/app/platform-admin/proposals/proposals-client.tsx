"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Factory,
  Filter,
  Handshake,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Search,
  Send,
  X,
} from "lucide-react";

import type { EligibleListing, getProposalData } from "./actions";
import type { Database } from "@/lib/platform-admin/database.types";
import { createInvitations, updateProposalState } from "./actions";
import { formatListingFilterLabel } from "@/lib/platform-admin/proposals/proposal-filter-utils";

import { Badge } from "@/app/components/platform-admin/ui/badge";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Checkbox } from "@/app/components/platform-admin/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/platform-admin/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/platform-admin/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/platform-admin/ui/dropdown-menu";
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
import { TablePagination } from "@/app/components/platform-admin/table-pagination";
import { CrmListShell } from "@/app/components/crm/crm-list-shell";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProposalsClientProps {
  proposals: Awaited<ReturnType<typeof getProposalData>>["proposals"];
  listings: Awaited<ReturnType<typeof getProposalData>>["listings"];
  recyclers: Awaited<ReturnType<typeof getProposalData>>["recyclers"];
  proposalListingOptions: Awaited<ReturnType<typeof getProposalData>>["proposalListingOptions"];
  recyclerFilterOptions: Awaited<ReturnType<typeof getProposalData>>["recyclerFilterOptions"];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type LinkState = Database["public"]["Enums"]["opportunity_link_state"];
type LinkType = "suggested" | "assigned" | "invited";
type ProposalView = "listing" | "recyclers" | "proposals";

const STATE_STYLES: Record<LinkState, { label: string; className: string }> = {
  active: {
    label: "Active",
    className: "bg-green-100 text-green-800 border-green-200",
  },
  paused: {
    label: "Paused",
    className: "bg-yellow-100 text-yellow-800 border-yellow-200",
  },
  archived: {
    label: "Archived",
    className: "bg-gray-100 text-gray-600 border-gray-200",
  },
  claimed: {
    label: "Claimed",
    className: "bg-blue-100 text-blue-800 border-blue-200",
  },
};

const TYPE_STYLES: Record<LinkType, { label: string; className: string }> = {
  suggested: {
    label: "Suggested",
    className: "bg-blue-100 text-blue-800 border-blue-200",
  },
  assigned: {
    label: "Assigned",
    className: "bg-purple-100 text-purple-800 border-purple-200",
  },
  invited: {
    label: "Invited",
    className: "bg-orange-100 text-orange-800 border-orange-200",
  },
};

const CHANNEL_STYLES: Record<string, { label: string; className: string }> = {
  recycling: {
    label: "Recycling",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  sale: {
    label: "Sale",
    className: "bg-sky-50 text-sky-700 border-sky-200",
  },
};

const VISIBILITY_STYLES: Record<string, { label: string; className: string }> = {
  public: {
    label: "Public",
    className: "bg-green-50 text-green-700 border-green-200",
  },
  buyer_network: {
    label: "Buyer network",
    className: "bg-orange-50 text-orange-700 border-orange-200",
  },
};

const LISTING_STATUS_STYLES: Record<
  Database["public"]["Enums"]["listing_status"],
  { label: string; className: string }
> = {
  published: { label: "Published", className: "bg-green-100 text-green-800 border-green-200" },
  draft: { label: "Draft", className: "bg-gray-100 text-gray-700 border-gray-200" },
  withdrawn: { label: "Withdrawn", className: "bg-red-100 text-red-700 border-red-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

const CAPACITY_BAND_LABELS: Record<string, string> = {
  lt_10_tons: "<10 t/mo",
  "10_50_tons": "10–50 t/mo",
  "50_100_tons": "50–100 t/mo",
  gt_100_tons: ">100 t/mo",
};

function formatCapacity(
  capacityKg: number | undefined,
  capacityBand: string | undefined
): string {
  if (capacityBand) {
    return CAPACITY_BAND_LABELS[capacityBand] ?? capacityBand.replace(/_/g, " ");
  }
  if (!capacityKg || capacityKg <= 0) return "—";
  const tons = capacityKg / 1000;
  if (tons < 1) return "<1 t/mo";
  if (tons >= 100) return ">100 t/mo";
  if (tons >= 10) return "10–100 t/mo";
  return "1–10 t/mo";
}

function assembleLocation(
  city: string | null | undefined,
  region: string | null | undefined,
  country: string | null | undefined
): string {
  return [city, region, country].filter(Boolean).join(", ") || "—";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProposalsClient({
  proposals,
  listings,
  recyclers,
  proposalListingOptions,
  recyclerFilterOptions,
}: ProposalsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [selectedListing, setSelectedListing] = useState<
    Pick<EligibleListing, "id" | "title" | "reference"> | null
  >(null);
  const [selectedRecyclerIds, setSelectedRecyclerIds] = useState<string[]>([]);
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [rebatteryNote, setRebatteryNote] = useState("");
  const [activeView, setActiveView] = useState<ProposalView>("listing");
  const listingSearch = searchParams.get("listingSearch") ?? "";
  const listingChannelFilter = searchParams.get("listingChannelFilter") ?? "all";
  const recyclerSearch = searchParams.get("recyclerSearch") ?? "";
  const chemistryFilter = searchParams.get("chemistryFilter") ?? "all";
  const capacityFilter = searchParams.get("capacityFilter") ?? "all";
  const countryFilter = searchParams.get("countryFilter") ?? "all";
  const proposalSearch = searchParams.get("proposalSearch") ?? "";
  const proposalListingFilter = searchParams.get("proposalListingFilter") ?? "all";
  const proposalStateFilter = searchParams.get("proposalStateFilter") ?? "all";
  const proposalTypeFilter = searchParams.get("proposalTypeFilter") ?? "all";
  const [listingSearchInput, setListingSearchInput] = useState(listingSearch);
  const [recyclerSearchInput, setRecyclerSearchInput] = useState(recyclerSearch);
  const [proposalSearchInput, setProposalSearchInput] = useState(proposalSearch);
  const previousListingSearch = useRef(listingSearch);
  const previousRecyclerSearch = useRef(recyclerSearch);
  const previousProposalSearch = useRef(proposalSearch);

  const hasActiveProposalFilters =
    proposalSearch !== "" ||
    proposalListingFilter !== "all" ||
    proposalStateFilter !== "all" ||
    proposalTypeFilter !== "all";

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }

    startTransition(() => {
      router.replace(`/platform-admin/proposals${params.size > 0 ? `?${params.toString()}` : ""}`);
    });
  }, [router, searchParams]);

  useEffect(() => {
    setListingSearchInput((current) =>
      current === previousListingSearch.current ? listingSearch : current
    );
    previousListingSearch.current = listingSearch;
  }, [listingSearch]);

  useEffect(() => {
    setRecyclerSearchInput((current) =>
      current === previousRecyclerSearch.current ? recyclerSearch : current
    );
    previousRecyclerSearch.current = recyclerSearch;
  }, [recyclerSearch]);

  useEffect(() => {
    setProposalSearchInput((current) =>
      current === previousProposalSearch.current ? proposalSearch : current
    );
    previousProposalSearch.current = proposalSearch;
  }, [proposalSearch]);

  useEffect(() => {
    if (listingSearchInput === listingSearch) return;
    const timeout = window.setTimeout(() => {
      updateParams({
        listingSearch: listingSearchInput.trim() ? listingSearchInput : null,
        listingPage: null,
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [listingSearch, listingSearchInput, updateParams]);

  useEffect(() => {
    if (recyclerSearchInput === recyclerSearch) return;
    const timeout = window.setTimeout(() => {
      updateParams({
        recyclerSearch: recyclerSearchInput.trim() ? recyclerSearchInput : null,
        recyclerPage: null,
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [recyclerSearch, recyclerSearchInput, updateParams]);

  useEffect(() => {
    if (proposalSearchInput === proposalSearch) return;
    const timeout = window.setTimeout(() => {
      updateParams({
        proposalSearch: proposalSearchInput.trim() ? proposalSearchInput : null,
        proposalPage: null,
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [proposalSearch, proposalSearchInput, updateParams]);

  // ── Create invitation batch ──────────────────────────────────────────────

  function openSendDialog() {
    if (!selectedListing || selectedRecyclerIds.length === 0) {
      toast.error("Select a listing and at least one recycler.");
      return;
    }
    setRebatteryNote("");
    setShowSendDialog(true);
  }

  async function handleCreateInvitations() {
    if (!selectedListing) {
      toast.error("Select a listing before sending invitations.");
      return;
    }

    setIsSubmitting(true);
    setShowSendDialog(false);
    try {
      const result = await createInvitations(
        selectedListing.id,
        selectedRecyclerIds,
        rebatteryNote.trim() || null
      );

      if (result.success) {
        toast.success(
          `Invitations sent. ${result.created} new, ${result.reactivated} reactivated, ${result.alreadyActive} already active. Emails: ${result.emailSent} sent, ${result.emailFailed} failed.`
        );
        setSelectedRecyclerIds([]);
        setRebatteryNote("");
        setActiveView("proposals");
        startTransition(() => router.refresh());
      } else {
        toast.error(result.error ?? "Failed to send invitations.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function toggleRecycler(recyclerId: string) {
    setSelectedRecyclerIds((cur) =>
      cur.includes(recyclerId) ? cur.filter((id) => id !== recyclerId) : [...cur, recyclerId]
    );
  }

  function toggleListing(listing: Pick<EligibleListing, "id" | "title" | "reference">) {
    setSelectedListing((current) => current?.id === listing.id ? null : listing);
  }

  function toggleProposal(proposalId: string) {
    setSelectedProposalIds((current) =>
      current.includes(proposalId)
        ? current.filter((id) => id !== proposalId)
        : [...current, proposalId]
    );
  }

  function toggleSelectAllFiltered() {
    const filteredIds = recyclers.rows.map((recycler) => recycler.id);
    const allSelected = filteredIds.every((id) => selectedRecyclerIds.includes(id));
    if (allSelected) {
      setSelectedRecyclerIds((cur) => cur.filter((id) => !filteredIds.includes(id)));
    } else {
      setSelectedRecyclerIds((cur) => Array.from(new Set([...cur, ...filteredIds])));
    }
  }

  function toggleSelectAllVisibleProposals() {
    const visibleIds = proposals.rows.map((proposal) => proposal.id);
    const allSelected = visibleIds.every((id) => selectedProposalIds.includes(id));
    setSelectedProposalIds((current) => allSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : Array.from(new Set([...current, ...visibleIds]))
    );
  }

  // ── Update proposal state ────────────────────────────────────────────────

  async function handleStateChange(proposalId: string, state: string, actionLabel: string) {
    const result = await updateProposalState(proposalId, state);

    if (result.success) {
      toast.success(`Proposal ${actionLabel.toLowerCase()}d successfully.`);
      startTransition(() => router.refresh());
    } else {
      toast.error(result.error ?? `Failed to ${actionLabel.toLowerCase()} proposal.`);
    }
  }

  function clearProposalFilters() {
    updateParams({
      proposalSearch: null,
      proposalListingFilter: null,
      proposalStateFilter: null,
      proposalTypeFilter: null,
      proposalPage: null,
    });
  }

  const isBusy = isSubmitting || isPending;
  const selectedRecyclerCount = selectedRecyclerIds.length;
  const allFilteredSelected =
    recyclers.rows.length > 0 &&
    recyclers.rows.every((recycler) => selectedRecyclerIds.includes(recycler.id));
  const someFilteredSelected =
    recyclers.rows.some((recycler) => selectedRecyclerIds.includes(recycler.id));
  const selectedProposalCount = selectedProposalIds.length;
  const allVisibleProposalsSelected =
    proposals.rows.length > 0 &&
    proposals.rows.every((proposal) => selectedProposalIds.includes(proposal.id));
  const someVisibleProposalsSelected =
    proposals.rows.some((proposal) => selectedProposalIds.includes(proposal.id));

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <CrmListShell title="Proposals" count={proposals.allCount}>
    <div className="space-y-6 p-5 lg:p-6">

      <nav
        className="grid gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-hover)]/60 p-2 lg:grid-cols-3"
        aria-label="Proposal workflow"
      >
        <Button
          type="button"
          variant={activeView === "listing" ? "secondary" : "ghost"}
          className="h-auto justify-start px-3 py-2.5"
          aria-pressed={activeView === "listing"}
          onClick={() => setActiveView("listing")}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-xs">
            {selectedListing ? <Check className="size-3.5" /> : "1"}
          </span>
          <span className="min-w-0 text-left">
            <span className="block text-sm font-medium">Choose listing</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {selectedListing?.title ?? "Select a published listing"}
            </span>
          </span>
        </Button>
        <Button
          type="button"
          variant={activeView === "recyclers" ? "secondary" : "ghost"}
          className="h-auto justify-start px-3 py-2.5"
          aria-pressed={activeView === "recyclers"}
          onClick={() => setActiveView("recyclers")}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-xs">
            {selectedRecyclerCount > 0 ? <Check className="size-3.5" /> : "2"}
          </span>
          <span className="min-w-0 text-left">
            <span className="block text-sm font-medium">Choose recyclers</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {selectedRecyclerCount > 0
                ? `${selectedRecyclerCount} selected`
                : "Filter and select recipients"}
            </span>
          </span>
        </Button>
        <Button
          type="button"
          variant={activeView === "proposals" ? "secondary" : "ghost"}
          className="h-auto justify-start px-3 py-2.5"
          aria-pressed={activeView === "proposals"}
          onClick={() => setActiveView("proposals")}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-xs">
            3
          </span>
          <span className="min-w-0 text-left">
            <span className="block text-sm font-medium">Existing proposals</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {proposals.allCount} total
            </span>
          </span>
        </Button>
      </nav>

      {/* ═══════════════════════════════════════════════════════════════════════
          1. Select Listing + Recyclers
          ═══════════════════════════════════════════════════════════════════════ */}
      {activeView !== "proposals" && (
        <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="text-base">
                {activeView === "listing" ? "1. Choose a Listing" : "2. Choose Recyclers"}
                {selectedListing && (
                  <Badge variant="secondary" className="ml-2 max-w-full font-normal">
                    <Check className="mr-1 h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {selectedListing.reference
                        ? `${selectedListing.reference} · ${selectedListing.title}`
                        : selectedListing.title}
                    </span>
                  </Badge>
                )}
                {selectedRecyclerCount > 0 && (
                  <Badge variant="secondary" className="ml-2 font-normal">
                    {selectedRecyclerCount} selected
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {activeView === "listing"
                  ? "Pick the published recycling listing you want to share."
                  : selectedListing
                    ? `Select recyclers to invite to ${selectedListing.title}.`
                    : "Select a listing first, then return here to choose recyclers."}
              </CardDescription>
            </div>
            {activeView === "listing" ? (
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={!selectedListing}
                onClick={() => setActiveView("recyclers")}
              >
                Continue to recyclers
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {activeView === "listing" ? (
          <div className="space-y-3">
          {/* Search + filter */}
          <div className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by listing ID, ref, title, or supplier..."
                  value={listingSearchInput}
                  onChange={(e) => setListingSearchInput(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>
            <Select
              value={listingChannelFilter}
              onValueChange={(value) =>
                updateParams({
                  listingChannelFilter: value === "all" ? null : value,
                  listingPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <Filter className="mr-1.5 h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="recycling">Recycling</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Listing table */}
          <div className="overflow-x-auto rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
            <Table className="min-w-[920px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead className="w-[220px]">Listing</TableHead>
                  <TableHead className="w-[160px]">Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Invites</TableHead>
                  <TableHead>Enquiries</TableHead>
                  <TableHead>Deals</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No listings match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  listings.rows.map((listing) => {
                    const isSelected = selectedListing?.id === listing.id;
                    const channel =
                      CHANNEL_STYLES[listing.channel_mode] ?? CHANNEL_STYLES["recycling"];
                    const visibility =
                      VISIBILITY_STYLES[listing.visibility] ?? VISIBILITY_STYLES["public"];
                    const status = LISTING_STATUS_STYLES[listing.listing_status];

                    return (
                      <TableRow
                        key={listing.id}
                        className="cursor-pointer"
                        data-state={isSelected ? "selected" : undefined}
                        onClick={() =>
                          toggleListing({
                            id: listing.id,
                            title: listing.title,
                            reference: listing.reference,
                          })
                        }
                      >
                        <TableCell>
                          <Checkbox
                            checked={isSelected}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => toggleListing({
                              id: listing.id,
                              title: listing.title,
                              reference: listing.reference,
                            })}
                            aria-label={`${isSelected ? "Deselect" : "Select"} ${listing.title}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{listing.title}</div>
                          {listing.reference && (
                            <div className="text-xs text-muted-foreground tabular-nums">
                              {listing.reference}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {listing.supplier_name ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={status.className}>
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={channel.className}>
                            {channel.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={visibility.className}>
                            {visibility.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm tabular-nums">
                            <span className={listing.invite_count > 0 ? "font-medium" : "text-muted-foreground"}>
                              {listing.invite_count}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-sm tabular-nums">
                            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className={listing.enquiry_count > 0 ? "font-medium" : "text-muted-foreground"}>
                              {listing.enquiry_count}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-sm tabular-nums">
                            <Handshake className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className={listing.deal_count > 0 ? "font-medium" : "text-muted-foreground"}>
                              {listing.deal_count}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular-nums text-sm whitespace-nowrap">
                          {formatDate(listing.created_at)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <TablePagination
            page={listings.page}
            pageSize={listings.pageSize}
            totalCount={listings.totalCount}
            totalPages={listings.totalPages}
            itemLabel="listing"
            onPageChange={(page) =>
              updateParams({ listingPage: page <= 1 ? null : String(page) })
            }
          />
          </div>

          ) : (
          <div className="space-y-3">
          {/* Search + filters */}
          <div className="grid gap-3 md:grid-cols-5">
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search any recycler field..."
                  value={recyclerSearchInput}
                  onChange={(e) => setRecyclerSearchInput(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            <Select
              value={chemistryFilter}
              onValueChange={(value) =>
                updateParams({
                  chemistryFilter: value === "all" ? null : value,
                  recyclerPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Chemistry" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All chemistries</SelectItem>
                {recyclerFilterOptions.chemistries.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={countryFilter}
              onValueChange={(value) =>
                updateParams({
                  countryFilter: value === "all" ? null : value,
                  recyclerPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Country" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                {recyclerFilterOptions.countries.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={capacityFilter}
              onValueChange={(value) =>
                updateParams({
                  capacityFilter: value === "all" ? null : value,
                  recyclerPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Capacity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All capacities</SelectItem>
                <SelectItem value="lt10">&lt;10 t/mo</SelectItem>
                <SelectItem value="10to100">10–100 t/mo</SelectItem>
                <SelectItem value="gt100">&gt;100 t/mo</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Summary bar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm">
            <p className="text-muted-foreground">
              {recyclers.totalCount} recycler
              {recyclers.totalCount !== 1 ? "s" : ""}
              {selectedRecyclerCount > 0 && (
                <span className="ml-1.5 font-medium text-[var(--color-text)]">
                  &middot; {selectedRecyclerCount} selected
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleSelectAllFiltered}
                className="h-8 px-2.5 text-xs"
              >
                {allFilteredSelected ? "Deselect visible" : "Select visible"}
              </Button>
              <Button
                onClick={openSendDialog}
                disabled={isBusy || !selectedListing || selectedRecyclerCount === 0}
                size="sm"
                className="h-8 px-2.5 text-xs gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {isSubmitting
                  ? "Sending..."
                  : selectedRecyclerCount > 0
                    ? `Send ${selectedRecyclerCount}`
                    : "Send invitations"}
              </Button>
            </div>
          </div>

          {/* Recycler table */}
          <div className="overflow-x-auto rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
            <Table className="min-w-[1160px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
                      onCheckedChange={toggleSelectAllFiltered}
                      disabled={recyclers.rows.length === 0}
                      aria-label={allFilteredSelected ? "Deselect visible recyclers" : "Select visible recyclers"}
                    />
                  </TableHead>
                  <TableHead>Recycler</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Chemistries</TableHead>
                  <TableHead>Formats</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recyclers.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No recyclers match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  recyclers.rows.map((recycler) => {
                    const checked = selectedRecyclerIds.includes(recycler.id);
                    const chemistries = recycler.public_fields.chemistries ?? [];
                    const formats = recycler.public_fields.accepted_formats ?? [];
                    const rType = recycler.public_fields.recycler_type;

                    return (
                      <TableRow
                        key={recycler.id}
                        className="cursor-pointer"
                        data-state={checked ? "selected" : undefined}
                        onClick={() => toggleRecycler(recycler.id)}
                      >
                        <TableCell>
                          <Checkbox
                            checked={checked}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => toggleRecycler(recycler.id)}
                            aria-label={`${checked ? "Deselect" : "Select"} ${recycler.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium leading-tight">
                            {recycler.display_name ?? recycler.name}
                          </div>
                          {recycler.display_name && (
                            <div className="text-xs text-muted-foreground">
                              {recycler.name}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {rType ? (
                            <Badge
                              variant="outline"
                              className={
                                rType === "battery"
                                  ? "bg-amber-50 text-amber-700 border-amber-200"
                                  : "bg-slate-50 text-slate-700 border-slate-200"
                              }
                            >
                              <Factory className="mr-1 h-3 w-3" />
                              {rType === "battery" ? "Battery" : "General"}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {chemistries.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {chemistries.map((c) => (
                                <Badge
                                  key={c}
                                  variant="secondary"
                                  className="text-xs font-normal"
                                >
                                  {c.toUpperCase()}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {formats.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {formats.slice(0, 3).map((f) => (
                                <Badge
                                  key={f}
                                  variant="outline"
                                  className="text-xs font-normal"
                                >
                                  {f}
                                </Badge>
                              ))}
                              {formats.length > 3 && (
                                <span className="text-xs text-muted-foreground">
                                  +{formats.length - 3}
                                </span>
                              )}
                            </div>
                          ) : recycler.public_fields.accepted_streams ? (
                            <span className="text-sm text-muted-foreground truncate max-w-[160px] block" title={recycler.public_fields.accepted_streams}>
                              {recycler.public_fields.accepted_streams}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums whitespace-nowrap">
                          {formatCapacity(recycler.public_fields.capacity_kg_per_month, recycler.public_fields.capacity_band)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 text-sm">
                            <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate max-w-[160px]">
                              {assembleLocation(
                                recycler.city,
                                recycler.region,
                                recycler.country
                              )}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <TablePagination
            page={recyclers.page}
            pageSize={recyclers.pageSize}
            totalCount={recyclers.totalCount}
            totalPages={recyclers.totalPages}
            itemLabel="recycler"
            onPageChange={(page) =>
              updateParams({ recyclerPage: page <= 1 ? null : String(page) })
            }
          />

          <p className="text-xs text-muted-foreground">
            Invitations are idempotent: existing active invites are kept, paused/archived
            invites are reactivated.
          </p>
          </div>
          )}
        </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          Existing Proposals
          ═══════════════════════════════════════════════════════════════════════ */}
      {activeView === "proposals" && (
        <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Existing Proposals</CardTitle>
              <CardDescription>
                {hasActiveProposalFilters
                  ? `${proposals.totalCount} of ${proposals.allCount} proposals`
                  : `${proposals.allCount} proposal${proposals.allCount !== 1 ? "s" : ""} total`}
                {selectedProposalCount > 0 ? ` · ${selectedProposalCount} selected` : ""}
              </CardDescription>
            </div>
            {hasActiveProposalFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearProposalFilters}
                className="h-8 px-2.5 text-xs gap-1 text-muted-foreground"
              >
                <X className="h-3 w-3" />
                Clear filters
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Search + filters */}
          <div className="grid gap-3 md:grid-cols-5">
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search listing, supplier, recycler, state, note..."
                  value={proposalSearchInput}
                  onChange={(e) => setProposalSearchInput(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            <Select
              value={proposalListingFilter}
              onValueChange={(value) =>
                updateParams({
                  proposalListingFilter: value === "all" ? null : value,
                  proposalPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <Filter className="mr-1.5 h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="Listing" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All listings</SelectItem>
                {proposalListingOptions.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {formatListingFilterLabel(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={proposalTypeFilter}
              onValueChange={(value) =>
                updateParams({
                  proposalTypeFilter: value === "all" ? null : value,
                  proposalPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <Filter className="mr-1.5 h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="invited">Invited</SelectItem>
                <SelectItem value="suggested">Suggested</SelectItem>
                <SelectItem value="assigned">Assigned</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={proposalStateFilter}
              onValueChange={(value) =>
                updateParams({
                  proposalStateFilter: value === "all" ? null : value,
                  proposalPage: null,
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <Filter className="mr-1.5 h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
                <SelectItem value="claimed">Claimed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {selectedProposalCount > 0
                ? `${selectedProposalCount} proposal${selectedProposalCount === 1 ? "" : "s"} selected`
                : "Select proposals individually or select the visible page."}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSelectAllVisibleProposals}
              disabled={proposals.rows.length === 0}
              className="h-8 px-2.5 text-xs"
            >
              {allVisibleProposalsSelected ? "Deselect visible" : "Select visible"}
            </Button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-sm)]">
            <Table className="min-w-[1280px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleProposalsSelected ? true : someVisibleProposalsSelected ? "indeterminate" : false}
                      onCheckedChange={toggleSelectAllVisibleProposals}
                      disabled={proposals.rows.length === 0}
                      aria-label={allVisibleProposalsSelected ? "Deselect visible proposals" : "Select visible proposals"}
                    />
                  </TableHead>
                  <TableHead className="min-w-[180px]">Listing</TableHead>
                  <TableHead className="min-w-[160px]">Recycler</TableHead>
                  <TableHead>Chemistries</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Type</TableHead>
                   <TableHead>State</TableHead>
                   <TableHead className="min-w-[160px]">Note</TableHead>
                   <TableHead>Created</TableHead>
                   <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposals.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                       colSpan={11}
                       className="text-center text-muted-foreground py-10"
                     >
                      {hasActiveProposalFilters
                        ? "No proposals match these filters."
                        : "No proposals yet."}
                    </TableCell>
                  </TableRow>
                ) : (
                  proposals.rows.map((proposal) => {
                    const stateKey = proposal.state as LinkState;
                    const isSelected = selectedProposalIds.includes(proposal.id);
                    const typeKey = proposal.link_type as LinkType;
                    const stateMeta = STATE_STYLES[stateKey] ?? STATE_STYLES["active"];
                    const typeMeta = TYPE_STYLES[typeKey] ?? TYPE_STYLES["suggested"];

                    const canPause = proposal.state === "active";
                    const canResume = proposal.state === "paused";
                    const canArchive = proposal.state !== "archived";
                    const hasActions = canPause || canResume || canArchive;

                    const chemistries = proposal.recycler_public_fields?.chemistries ?? [];
                    const location = assembleLocation(
                      proposal.recycler_city,
                      proposal.recycler_region,
                      proposal.recycler_country
                    );

                    return (
                      <TableRow
                        key={proposal.id}
                        className="cursor-pointer"
                        data-state={isSelected ? "selected" : undefined}
                        onClick={() => toggleProposal(proposal.id)}
                      >
                        <TableCell>
                          <Checkbox
                            checked={isSelected}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => toggleProposal(proposal.id)}
                            aria-label={`${isSelected ? "Deselect" : "Select"} ${proposal.listing_title ?? "Unknown listing"} proposal for ${proposal.recycler_display_name ?? proposal.recycler_name ?? "unknown recycler"}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div
                            className="font-medium leading-tight max-w-[220px] truncate"
                            title={proposal.listing_title ?? undefined}
                          >
                            {proposal.listing_title ?? (
                              <span className="text-muted-foreground italic">
                                Unknown listing
                              </span>
                            )}
                          </div>
                          {proposal.listing_reference && (
                            <div className="text-xs text-muted-foreground tabular-nums">
                              {proposal.listing_reference}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="leading-tight">
                            <div
                              className="font-medium max-w-[180px] truncate"
                              title={
                                proposal.recycler_display_name ??
                                proposal.recycler_name ??
                                undefined
                              }
                            >
                              {proposal.recycler_display_name ??
                                proposal.recycler_name ?? (
                                  <span className="text-muted-foreground italic">
                                    Unknown
                                  </span>
                                )}
                            </div>
                            {proposal.recycler_display_name && proposal.recycler_name && (
                              <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                                {proposal.recycler_name}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {chemistries.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {chemistries.slice(0, 3).map((c) => (
                                <Badge
                                  key={c}
                                  variant="secondary"
                                  className="text-xs font-normal"
                                >
                                  {c.toUpperCase()}
                                </Badge>
                              ))}
                              {chemistries.length > 3 && (
                                <span className="text-xs text-muted-foreground">
                                  +{chemistries.length - 3}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {location !== "—" ? (
                            <div className="flex items-center gap-1 text-sm">
                              <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                              <span className="truncate max-w-[140px]" title={location}>
                                {location}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums whitespace-nowrap">
                          {formatCapacity(
                            proposal.recycler_public_fields?.capacity_kg_per_month,
                            proposal.recycler_public_fields?.capacity_band
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={typeMeta.className}>
                            {typeMeta.label}
                          </Badge>
                        </TableCell>
                         <TableCell>
                           <Badge variant="outline" className={stateMeta.className}>
                             {stateMeta.label}
                           </Badge>
                         </TableCell>
                         <TableCell>
                           {proposal.rebattery_notes ? (
                             <span
                               className="text-sm text-muted-foreground line-clamp-2 max-w-[200px] block"
                               title={proposal.rebattery_notes}
                             >
                               {proposal.rebattery_notes}
                             </span>
                           ) : (
                             <span className="text-muted-foreground text-sm">—</span>
                           )}
                         </TableCell>
                         <TableCell className="text-muted-foreground tabular-nums text-sm whitespace-nowrap">
                           {formatDate(proposal.created_at)}
                         </TableCell>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          {hasActions && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label="Open actions"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canPause && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      handleStateChange(proposal.id, "paused", "Pause")
                                    }
                                  >
                                    Pause
                                  </DropdownMenuItem>
                                )}
                                {canResume && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      handleStateChange(proposal.id, "active", "Resume")
                                    }
                                  >
                                    Resume
                                  </DropdownMenuItem>
                                )}
                                {canArchive && (
                                  <DropdownMenuItem
                                    className="text-[var(--color-error)] focus:text-[var(--color-error)]"
                                    onSelect={() =>
                                      handleStateChange(proposal.id, "archived", "Archive")
                                    }
                                  >
                                    Archive
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <TablePagination
            page={proposals.page}
            pageSize={proposals.pageSize}
            totalCount={proposals.totalCount}
            totalPages={proposals.totalPages}
            itemLabel="proposal"
            onPageChange={(page) =>
              updateParams({ proposalPage: page <= 1 ? null : String(page) })
            }
          />
        </CardContent>
        </Card>
      )}
      {/* ── Send Invitations confirmation dialog ── */}
      <Dialog open={showSendDialog} onOpenChange={setShowSendDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Invitations</DialogTitle>
            <DialogDescription>
              You are about to invite{" "}
              <span className="font-medium text-[var(--color-text)]">
                {selectedRecyclerCount} recycler{selectedRecyclerCount !== 1 ? "s" : ""}
              </span>{" "}
              to{" "}
              <span className="font-medium text-[var(--color-text)]">
                {selectedListing?.title ?? "this listing"}
              </span>
              . Optionally add an internal note that will be stored on each opportunity link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="rebattery-note" className="text-sm font-medium">
              Internal note{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="rebattery-note"
              placeholder="e.g. Matched based on LFP chemistry and EU capacity — high priority outreach"
              value={rebatteryNote}
              onChange={(e) => setRebatteryNote(e.target.value)}
              rows={3}
              className="resize-none text-sm"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSendDialog(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreateInvitations}
              disabled={isSubmitting}
              className="gap-1.5"
            >
              <Send className="h-3.5 w-3.5" />
              {isSubmitting ? "Sending..." : `Send ${selectedRecyclerCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </CrmListShell>
  );
}

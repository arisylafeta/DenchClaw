"use server";

import { unstable_noStore as noStore } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import { getSiteEnv } from "@/lib/platform-admin/env";
import { sendRecyclerOpportunityInvitationEmail } from "@/lib/platform-admin/email/templates/recycler-opportunity-invitation";
import type { Database } from "@/lib/platform-admin/database.types";
import { filterProposals, getUniqueProposalListings } from "@/lib/platform-admin/proposals/proposal-filter-utils";
import { mapWithConcurrency } from "@/lib/platform-admin/async";
import { readAllRows, readAllRowsInBatches, readRowsInBatches } from "@/lib/platform-admin/queries";

// ─── Row types derived from the generated types ───────────────────────────────

type OpportunityLinkRow =
  Database["public"]["Tables"]["recycler_opportunity_links"]["Row"];

type ListingRow = Database["public"]["Tables"]["listings"]["Row"];

type AccountRow = Database["public"]["Tables"]["accounts"]["Row"];
type Json = Database["public"]["Tables"]["account_profiles_public"]["Row"]["public_fields_json"];
const PAGE_SIZE = 25;

type PaginatedRows<T> = {
  rows: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  allCount: number;
};

// ─── Enriched proposal row (returned from getProposalData) ───────────────────

export type ProposalRow = OpportunityLinkRow & {
  listing_title: string | null;
  listing_reference: string | null;
  listing_supplier_name: string | null;
  recycler_name: string | null;
  recycler_display_name: string | null;
  recycler_city: string | null;
  recycler_region: string | null;
  recycler_country: string | null;
  recycler_public_fields: RecyclerDirectoryFields;
};

export type EligibleListing = Pick<
  ListingRow,
  "id" | "title" | "channel_mode" | "visibility" | "listing_status" | "created_at"
> & {
  reference: string | null;
  supplier_name: string | null;
  invite_count: number;
  enquiry_count: number;
  deal_count: number;
};

export type RecyclerDirectoryFields = {
  recycler_type?: "battery" | "general";
  chemistries?: string[];
  accepted_formats?: string[];
  capacity_kg_per_month?: number;
  capacity_band?: string;
  accepted_streams?: string;
};

export type EligibleRecycler = Pick<AccountRow, "id" | "name" | "status"> & {
  display_name: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  public_fields: RecyclerDirectoryFields;
};

export type CreateInvitationsResult = {
  success: boolean;
  created: number;
  reactivated: number;
  alreadyActive: number;
  emailSent: number;
  emailFailed: number;
  error?: string;
};

type ProposalDataParams = {
  proposalPage?: number;
  listingPage?: number;
  recyclerPage?: number;
  proposalSearch?: string;
  proposalListingFilter?: string;
  proposalStateFilter?: string;
  proposalTypeFilter?: string;
  listingSearch?: string;
  listingChannelFilter?: string;
  recyclerSearch?: string;
  chemistryFilter?: string;
  countryFilter?: string;
  capacityFilter?: string;
};

function paginateRows<T>(rows: T[], page: number, pageSize = PAGE_SIZE): PaginatedRows<T> {
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const totalCount = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    rows: rows.slice(start, start + pageSize),
    page: currentPage,
    pageSize,
    totalCount,
    totalPages,
    allCount: rows.length,
  };
}

function parseRecyclerDirectoryFields(
  publicFields: Json,
  opsJson: unknown
): RecyclerDirectoryFields {
  const toStringArray = (v: unknown) =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : undefined;

  // Try public_fields_json first (may be populated in future)
  const pub =
    publicFields && typeof publicFields === "object" && !Array.isArray(publicFields)
      ? (publicFields as Record<string, unknown>)
      : {};

  // Extract from ops_json.onboarding.details (private profile, always populated)
  const ops =
    opsJson && typeof opsJson === "object" && !Array.isArray(opsJson)
      ? (opsJson as Record<string, unknown>)
      : {};
  const onboarding =
    ops.onboarding && typeof ops.onboarding === "object" && !Array.isArray(ops.onboarding)
      ? (ops.onboarding as Record<string, unknown>)
      : {};
  const details =
    onboarding.details && typeof onboarding.details === "object" && !Array.isArray(onboarding.details)
      ? (onboarding.details as Record<string, unknown>)
      : {};

  // Sector from onboarding can hint at recycler type
  const sector = typeof onboarding.sector === "string" ? onboarding.sector : undefined;
  const recyclerTypeFromSector =
    sector === "recycling" ? ("battery" as const) : sector ? ("general" as const) : undefined;

  return {
    recycler_type:
      pub.recycler_type === "battery" || pub.recycler_type === "general"
        ? pub.recycler_type
        : recyclerTypeFromSector,
    chemistries: toStringArray(pub.chemistries),
    accepted_formats: toStringArray(pub.accepted_formats),
    capacity_kg_per_month:
      typeof pub.capacity_kg_per_month === "number" ? pub.capacity_kg_per_month : undefined,
    capacity_band:
      typeof details.recycler_processing_capacity_band === "string"
        ? details.recycler_processing_capacity_band
        : undefined,
    accepted_streams:
      typeof details.recycler_accepted_streams === "string"
        ? details.recycler_accepted_streams
        : undefined,
  };
}

/** Extract location from addresses_json (first default address) */
function parseAddressLocation(addressesJson: unknown): {
  city: string | null;
  region: string | null;
  country: string | null;
} {
  if (!Array.isArray(addressesJson) || addressesJson.length === 0) {
    return { city: null, region: null, country: null };
  }
  const defaultAddr =
    (addressesJson as Array<Record<string, unknown>>).find((a) => a.isDefault === true) ??
    (addressesJson as Array<Record<string, unknown>>)[0];

  return {
    city: typeof defaultAddr?.city === "string" ? defaultAddr.city : null,
    region: typeof defaultAddr?.region === "string" ? defaultAddr.region : null,
    country: typeof defaultAddr?.country === "string" ? defaultAddr.country : null,
  };
}

/**
 * Resolve an account's recipient email via membership -> users -> auth.users.
 */
async function getAccountRecipient(
  accountId: string,
): Promise<{ email: string; name: string } | null> {
  const supabase = getSupabaseAdminClient();

  const { data: membership } = await supabase
    .from("account_memberships")
    .select("user_id")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership?.user_id) return null;

  const { data: publicUser } = await supabase
    .from("users")
    .select("auth_user_id, full_name")
    .eq("id", membership.user_id)
    .single();

  if (!publicUser?.auth_user_id) return null;

  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(
    publicUser.auth_user_id,
  );

  if (authErr || !authUser?.user?.email) return null;

  return {
    email: authUser.user.email,
    name: publicUser.full_name ?? authUser.user.email,
  };
}

// ─── getProposalData ──────────────────────────────────────────────────────────

export async function getProposalData(params: ProposalDataParams = {}) {
  return getProposalDataWithParams(params);
}

async function getProposalDataWithParams({
  proposalPage = 1,
  listingPage = 1,
  recyclerPage = 1,
  proposalSearch = "",
  proposalListingFilter = "all",
  proposalStateFilter = "all",
  proposalTypeFilter = "all",
  listingSearch = "",
  listingChannelFilter = "all",
  recyclerSearch = "",
  chemistryFilter = "all",
  countryFilter = "all",
  capacityFilter = "all",
}: ProposalDataParams) {
  noStore();
  const supabase = getSupabaseAdminClient();

  const [proposalRows, listingRows, recyclerRows] = await Promise.all([
    readAllRows((from, to) => supabase
      .from("recycler_opportunity_links")
      .select(
        "id, listing_id, recycler_account_id, link_type, state, rebattery_notes, created_at, updated_at, expires_at, listings(title, reference, accounts!listings_supplier_account_id_fkey(name)), accounts!recycler_opportunity_links_recycler_account_id_fkey(name, account_profiles_public(display_name, public_fields_json), account_profiles_private(addresses_json, ops_json))"
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to), { maxRows: 10_000 }),

    readAllRows((from, to) => supabase
      .from("listings")
      .select("id, title, reference, channel_mode, visibility, listing_status, created_at, accounts!listings_supplier_account_id_fkey(name)")
      .eq("listing_status", "published")
      .in("channel_mode", ["recycling"])
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to), { maxRows: 5_000 }),

    readAllRows((from, to) => supabase
      .from("accounts")
      .select(
        "id, name, status, account_profiles_public(display_name, public_fields_json), account_profiles_private(addresses_json, ops_json)"
      )
      .eq("role", "recycler")
      .in("status", ["active", "approved"])
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to), { maxRows: 5_000 }),
  ]);

  // Flatten nested join data into ProposalRow shape
  const proposals: ProposalRow[] = proposalRows.map((row) => {
    const { listings, accounts, ...rest } = row as typeof row & {
      listings: {
        title: string;
        reference: string | null;
        accounts: { name: string } | null;
      } | null;
      accounts: {
        name: string;
        account_profiles_public:
          | { display_name: string | null; public_fields_json: Json }
          | { display_name: string | null; public_fields_json: Json }[]
          | null;
        account_profiles_private:
          | { addresses_json: unknown; ops_json: unknown }
          | { addresses_json: unknown; ops_json: unknown }[]
          | null;
      } | null;
    };

    const pubProfile = accounts
      ? Array.isArray(accounts.account_profiles_public)
        ? accounts.account_profiles_public[0] ?? null
        : accounts.account_profiles_public
      : null;

    const privProfile = accounts
      ? Array.isArray(accounts.account_profiles_private)
        ? accounts.account_profiles_private[0] ?? null
        : accounts.account_profiles_private
      : null;

    const location = parseAddressLocation(privProfile?.addresses_json ?? null);

    return {
      ...rest,
      listing_title: listings?.title ?? null,
      listing_reference: listings?.reference ?? null,
      listing_supplier_name: listings?.accounts?.name ?? null,
      recycler_name: accounts?.name ?? null,
      recycler_display_name: pubProfile?.display_name ?? null,
      recycler_city: location.city,
      recycler_region: location.region,
      recycler_country: location.country,
      recycler_public_fields: parseRecyclerDirectoryFields(
        pubProfile?.public_fields_json ?? null,
        privProfile?.ops_json ?? null
      ),
    };
  });

  // Fetch activity counts (enquiries + deals) for all eligible listings
  const listingIds = listingRows.map((row) => row.id);
  const activityCounts = new Map<string, { enquiry_count: number; deal_count: number }>();
  const inviteCounts = new Map<string, number>();

  if (listingIds.length > 0) {
    const [countsData, invitesData] = await Promise.all([
      readRowsInBatches(listingIds, (ids) => supabase.rpc("get_listing_activity_counts", {
        listing_ids: ids,
      })),
      readAllRowsInBatches(listingIds, (ids, from, to) => supabase
        .from("recycler_opportunity_links")
        .select("id, listing_id")
        .in("listing_id", ids)
        .order("id", { ascending: true })
        .range(from, to), { maxRowsPerBatch: 10_000 }),
    ]);

    for (const row of countsData) {
      activityCounts.set(row.listing_id, {
        enquiry_count: Number(row.enquiry_count),
        deal_count: Number(row.deal_count),
      });
    }

    for (const row of invitesData) {
      inviteCounts.set(row.listing_id, (inviteCounts.get(row.listing_id) ?? 0) + 1);
    }
  }

  const listings = listingRows.map((row) => {
      const { accounts, ...rest } = row as typeof row & {
        accounts: { name: string } | null;
      };
      const counts = activityCounts.get(rest.id);
      return {
        ...rest,
        reference: (rest as typeof rest & { reference?: string | null }).reference ?? null,
        supplier_name: accounts?.name ?? null,
        invite_count: inviteCounts.get(rest.id) ?? 0,
        enquiry_count: counts?.enquiry_count ?? 0,
        deal_count: counts?.deal_count ?? 0,
      } satisfies EligibleListing;
    });

  const recyclers = recyclerRows.map((row) => {
      const pubProfile = Array.isArray(row.account_profiles_public)
        ? row.account_profiles_public[0] ?? null
        : row.account_profiles_public;

      const privProfile = Array.isArray(
        (row as typeof row & { account_profiles_private: unknown }).account_profiles_private
      )
        ? ((row as typeof row & { account_profiles_private: { addresses_json: unknown; ops_json: unknown }[] }).account_profiles_private[0] ?? null)
        : ((row as typeof row & { account_profiles_private: { addresses_json: unknown; ops_json: unknown } | null }).account_profiles_private ?? null);

      const location = parseAddressLocation(privProfile?.addresses_json ?? null);

      return {
        id: row.id,
        name: row.name,
        status: row.status,
        display_name: pubProfile?.display_name ?? null,
        city: location.city,
        region: location.region,
        country: location.country,
        public_fields: parseRecyclerDirectoryFields(
          pubProfile?.public_fields_json ?? null,
          privProfile?.ops_json ?? null
        ),
      } satisfies EligibleRecycler;
    });

  const filteredListings = listings.filter((listing) => {
    if (listingSearch.trim()) {
      const fields = [
        listing.id,
        listing.reference,
        listing.title,
        listing.supplier_name,
        listing.listing_status,
        listing.channel_mode,
        listing.visibility,
        listing.invite_count,
        listing.enquiry_count,
        listing.deal_count,
        listing.created_at,
      ];

      if (!matchesSearch(fields, listingSearch)) {
        return false;
      }
    }

    if (listingChannelFilter !== "all" && listing.channel_mode !== listingChannelFilter) {
      return false;
    }

    return true;
  });

  const filteredRecyclers = recyclers.filter((recycler) => {
    if (recyclerSearch.trim()) {
      const fields = [
        recycler.id,
        recycler.display_name,
        recycler.name,
        recycler.status,
        recycler.country,
        recycler.region,
        recycler.city,
        recycler.public_fields.recycler_type,
        ...(recycler.public_fields.chemistries ?? []),
        ...(recycler.public_fields.accepted_formats ?? []),
        recycler.public_fields.capacity_kg_per_month,
        recycler.public_fields.capacity_band,
        recycler.public_fields.accepted_streams,
      ];

      if (!matchesSearch(fields, recyclerSearch)) {
        return false;
      }
    }

    if (chemistryFilter !== "all") {
      const hasChemistry = (recycler.public_fields.chemistries ?? [])
        .map((chemistry) => chemistry.toLowerCase())
        .includes(chemistryFilter);

      if (!hasChemistry) {
        return false;
      }
    }

    if (countryFilter !== "all" && recycler.country !== countryFilter) {
      return false;
    }

    const capacity = recycler.public_fields.capacity_kg_per_month;
    if (capacityFilter === "lt10" && !(typeof capacity === "number" && capacity < 10_000)) {
      return false;
    }
    if (
      capacityFilter === "10to100" &&
      !(typeof capacity === "number" && capacity >= 10_000 && capacity <= 100_000)
    ) {
      return false;
    }
    if (capacityFilter === "gt100" && !(typeof capacity === "number" && capacity > 100_000)) {
      return false;
    }

    return true;
  });

  const filteredProposals = filterProposals(proposals, {
    search: proposalSearch,
    listingId: proposalListingFilter,
    state: proposalStateFilter,
    type: proposalTypeFilter,
  });

  const proposalListingOptions = getUniqueProposalListings(proposals);
  const recyclerFilterOptions = {
    chemistries: Array.from(
      new Set(
        recyclers.flatMap((recycler) =>
          (recycler.public_fields.chemistries ?? []).map((chemistry) => chemistry.toLowerCase())
        )
      )
    ).sort(),
    countries: Array.from(
      new Set(recyclers.map((recycler) => recycler.country).filter((value): value is string => Boolean(value)))
    ).sort(),
  };

  return {
    proposals: {
      ...paginateRows(filteredProposals, proposalPage),
      allCount: proposals.length,
    },
    listings: {
      ...paginateRows(filteredListings, listingPage),
      allCount: listings.length,
    },
    recyclers: {
      ...paginateRows(filteredRecyclers, recyclerPage),
      allCount: recyclers.length,
    },
    proposalListingOptions,
    recyclerFilterOptions,
  };
}

function matchesSearch(
  values: Array<string | number | null | undefined>,
  search: string
): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[_-]+/g, " ");
  const terms = normalize(search).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = normalize(values.filter((value) => value != null).join(" "));
  return terms.every((term) => haystack.includes(term));
}

// ─── createInvitations ────────────────────────────────────────────────────────

export async function createInvitations(
  listingId: string,
  recyclerAccountIds: string[],
  rebatteryNotes?: string | null
): Promise<CreateInvitationsResult> {
  const recyclerIds = Array.from(new Set(recyclerAccountIds.filter(Boolean)));
  if (!listingId || recyclerIds.length === 0) {
    return {
      success: false,
      created: 0,
      reactivated: 0,
      alreadyActive: 0,
      emailSent: 0,
      emailFailed: 0,
      error: "Listing and at least one recycler are required.",
    };
  }
  if (recyclerIds.length > 100) {
    return {
      success: false,
      created: 0,
      reactivated: 0,
      alreadyActive: 0,
      emailSent: 0,
      emailFailed: 0,
      error: "Send invitations to no more than 100 recyclers at a time.",
    };
  }

  const supabase = getSupabaseAdminClient();

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select(
      "id, title, seo_slug, listing_status, channel_mode, listing_specs(manufacturer, model, format, chemistry, pack_weight_kg, quantity, original_application, location_country)"
    )
    .eq("id", listingId)
    .eq("listing_status", "published")
    .eq("channel_mode", "recycling")
    .maybeSingle();

  if (listingError || !listing) {
    return {
      success: false,
      created: 0,
      reactivated: 0,
      alreadyActive: 0,
      emailSent: 0,
      emailFailed: 0,
      error: listingError?.message ?? "Listing is no longer eligible for recycler invitations.",
    };
  }

  let eligibleRecyclerRows: Array<{ id: string }>;
  let existingLinks: Array<{ id: string; recycler_account_id: string; state: string }>;
  try {
    [eligibleRecyclerRows, existingLinks] = await Promise.all([
      readRowsInBatches(recyclerIds, (ids) => supabase
        .from("accounts")
        .select("id")
        .in("id", ids)
        .eq("role", "recycler")
        .in("status", ["active", "approved"])),
      readRowsInBatches(recyclerIds, (ids) => supabase
        .from("recycler_opportunity_links")
        .select("id, recycler_account_id, state")
        .eq("listing_id", listingId)
        .eq("link_type", "invited")
        .in("recycler_account_id", ids)),
    ]);
  } catch (error) {
    return {
      success: false,
      created: 0,
      reactivated: 0,
      alreadyActive: 0,
      emailSent: 0,
      emailFailed: 0,
      error: error instanceof Error ? error.message : "Could not validate the selected recyclers.",
    };
  }

  const eligibleRecyclerIds = new Set(
    eligibleRecyclerRows.map((recycler) => recycler.id),
  );
  if (recyclerIds.some((recyclerId) => !eligibleRecyclerIds.has(recyclerId))) {
    return {
      success: false,
      created: 0,
      reactivated: 0,
      alreadyActive: 0,
      emailSent: 0,
      emailFailed: 0,
      error: "One or more selected recyclers are no longer eligible for invitations.",
    };
  }

  const byRecycler = new Map(
    existingLinks.map((link) => [link.recycler_account_id, link])
  );

  const notes = rebatteryNotes?.trim() || null;

  const toInsert: { listing_id: string; recycler_account_id: string; link_type: "invited"; state: "active"; expires_at: string; rebattery_notes: string | null }[] = [];
  const toReactivateIds: string[] = [];
  const toReactivateRecyclerIds: string[] = [];
  let alreadyActive = 0;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  const expiresAtIso = expiresAt.toISOString();

  for (const recyclerId of recyclerIds) {
    const existing = byRecycler.get(recyclerId);
    if (!existing) {
      toInsert.push({
        listing_id: listingId,
        recycler_account_id: recyclerId,
        link_type: "invited",
        state: "active",
        expires_at: expiresAtIso,
        rebattery_notes: notes,
      });
      continue;
    }

    if (existing.state === "active" || existing.state === "claimed") {
      alreadyActive += 1;
    } else {
      toReactivateIds.push(existing.id);
      toReactivateRecyclerIds.push(recyclerId);
    }
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from("recycler_opportunity_links")
      .insert(toInsert);

    if (insertError) {
      return {
        success: false,
        created: 0,
        reactivated: 0,
        alreadyActive,
        emailSent: 0,
        emailFailed: 0,
        error: insertError.message,
      };
    }
  }

  if (toReactivateIds.length > 0) {
    const { error: updateError } = await supabase
      .from("recycler_opportunity_links")
      .update({ state: "active", link_type: "invited", expires_at: expiresAtIso, rebattery_notes: notes })
      .in("id", toReactivateIds);

    if (updateError) {
      return {
        success: false,
        created: toInsert.length,
        reactivated: 0,
        alreadyActive,
        emailSent: 0,
        emailFailed: 0,
        error: updateError.message,
      };
    }
  }

  // Notify recyclers for links that became active in this action
  const activatedRecyclerIds = [
    ...toInsert.map((row) => row.recycler_account_id),
    ...toReactivateRecyclerIds,
  ];

  let emailSent = 0;
  let emailFailed = 0;

  if (activatedRecyclerIds.length > 0) {
    const siteUrl = getSiteEnv().siteUrl;
    const listingUrl = listing.seo_slug
      ? `${siteUrl}/recycler/opportunities/${listing.seo_slug}`
      : `${siteUrl}/recycler/opportunities/${listing.id}`;

    const listingSpec = Array.isArray(
      (listing as typeof listing & { listing_specs: unknown }).listing_specs,
    )
      ? ((listing as typeof listing & {
          listing_specs: {
            manufacturer: string | null;
            model: string | null;
            format: string | null;
            chemistry: string | null;
            pack_weight_kg: number | null;
            quantity: number | null;
            original_application: string | null;
            location_country: string | null;
          }[];
        }).listing_specs[0] ?? null)
      : ((listing as typeof listing & {
          listing_specs: {
            manufacturer: string | null;
            model: string | null;
            format: string | null;
            chemistry: string | null;
            pack_weight_kg: number | null;
            quantity: number | null;
            original_application: string | null;
            location_country: string | null;
          } | null;
        }).listing_specs ?? null);

    const units = listingSpec?.quantity && listingSpec.quantity > 0 ? listingSpec.quantity : 1;
    const totalWeightKg =
      listingSpec?.pack_weight_kg != null
        ? (listingSpec.pack_weight_kg * units).toFixed(0)
        : "—";

    const recipients = await mapWithConcurrency(
      activatedRecyclerIds,
      5,
      (accountId) => getAccountRecipient(accountId),
    );

    const sendResults = await mapWithConcurrency(
      recipients,
      5,
      async (recipient) => {
        if (!recipient) return { success: false as const };

        const result = await sendRecyclerOpportunityInvitationEmail(recipient.email, {
          recipient_name: recipient.name,
          listing_title: listing.title,
          units,
          manufacturer: listingSpec?.manufacturer ?? "Battery",
          model: listingSpec?.model ?? "Listing",
          unit_format: listingSpec?.format ?? "units",
          chemistry: listingSpec?.chemistry ?? "Unknown",
          total_weight_kg: totalWeightKg,
          application: listingSpec?.original_application ?? "Not specified",
          country: listingSpec?.location_country ?? "Unknown",
          listing_url: listingUrl,
        });

        return { success: result.success };
      },
    );

    for (const row of sendResults) {
      if (row.success) {
        emailSent += 1;
      } else {
        emailFailed += 1;
      }
    }
  }

  return {
    success: true,
    created: toInsert.length,
    reactivated: toReactivateIds.length,
    alreadyActive,
    emailSent,
    emailFailed,
  };
}

// ─── updateProposalState ──────────────────────────────────────────────────────

export async function updateProposalState(
  proposalId: string,
  state: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseAdminClient();

  const { error } = await supabase
    .from("recycler_opportunity_links")
    .update({ state: state as Database["public"]["Enums"]["opportunity_link_state"] })
    .eq("id", proposalId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

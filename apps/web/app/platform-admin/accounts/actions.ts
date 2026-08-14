"use server";

import { unstable_noStore as noStore } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import { getSiteEnv } from "@/lib/platform-admin/env";
import { sendAccountApprovedEmail } from "@/lib/platform-admin/email/templates/account-approved";
import { sendAdminMessageEmail } from "@/lib/platform-admin/email/templates/admin-message";
import type { Enums } from "@/lib/platform-admin/database.types";

type AccountStatus = Enums<"account_status">;
type AccountRole = Enums<"account_role">;

const ACCOUNT_ROLES: readonly AccountRole[] = ["buyer", "supplier", "recycler"];

export type AccountMemberDetails = {
  user_id: string;
  membership_role: string;
  is_primary: boolean;
  joined_at: string;
  email: string | null;
  full_name: string | null;
  phone_number: string | null;
  position: string | null;
  status: AccountStatus | null;
};

export type AccountDetails = {
  account: {
    id: string;
    name: string;
    role: Enums<"account_role">;
    account_type: Enums<"account_type">;
    status: AccountStatus;
    sector: Enums<"account_sector"> | null;
    created_at: string;
    updated_at: string;
    stripe_connect_status: string;
    stripe_connect_account_id: string | null;
    stripe_connect_onboarded_at: string | null;
  };
  publicProfile: {
    display_name: string;
    about: string | null;
    website_url: string | null;
    seo_slug: string | null;
    public_fields_json: unknown;
  } | null;
  privateProfile: {
    addresses_json: unknown;
    ops_json: unknown;
    tax_registered: boolean;
    tax_id: string | null;
    company_number: string | null;
    billing_address: unknown;
    created_at: string;
    updated_at: string;
  } | null;
  members: AccountMemberDetails[];
};

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

export async function getAccounts() {
  noStore();
  const supabase = getSupabaseAdminClient();

  const { data: accounts, error: accountsError } = await supabase
    .from("accounts")
    .select("id, name, role, account_type, status, created_at")
    .order("created_at", { ascending: false });

  if (accountsError) {
    throw new Error(accountsError.message);
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("account_profiles_public")
    .select("account_id, display_name");

  if (profilesError) {
    throw new Error(profilesError.message);
  }

  const accountIds = (accounts ?? []).map((a) => a.id);

  const privateProfileMap = new Map<
    string,
    { city: string | null; region: string | null; country: string | null }
  >();

  if (accountIds.length > 0) {
    const { data: privateProfiles, error: privError } = await supabase
      .from("account_profiles_private")
      .select("account_id, addresses_json")
      .in("account_id", accountIds);

    if (privError) {
      throw new Error(privError.message);
    }

    for (const pp of privateProfiles ?? []) {
      const { city, region, country } = parseAddressLocation(pp.addresses_json);
      privateProfileMap.set(pp.account_id, { city, region, country });
    }
  }

  let primaryUserByAccount = new Map<string, string>();

  if (accountIds.length > 0) {
    const { data: memberships, error: membershipsError } = await supabase
      .from("account_memberships")
      .select("account_id, user_id, is_primary, created_at")
      .in("account_id", accountIds)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });

    if (membershipsError) {
      throw new Error(membershipsError.message);
    }

    primaryUserByAccount = new Map<string, string>();
    for (const membership of memberships ?? []) {
      if (!primaryUserByAccount.has(membership.account_id)) {
        primaryUserByAccount.set(membership.account_id, membership.user_id);
      }
    }
  }

  const primaryUserIds = [...new Set(primaryUserByAccount.values())];

  let userEmailById = new Map<string, string>();
  if (primaryUserIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, email")
      .in("id", primaryUserIds);

    if (usersError) {
      throw new Error(usersError.message);
    }

    userEmailById = new Map((users ?? []).map((u) => [u.id, u.email]));
  }

  const profileMap = new Map(
    (profiles ?? []).map((p) => [p.account_id, p])
  );

  return (accounts ?? []).map((account) => {
    const profile = profileMap.get(account.id) ?? null;
    const locationData = privateProfileMap.get(account.id);
    const locationParts = [locationData?.city, locationData?.region, locationData?.country].filter(Boolean);
    const primaryUserId = primaryUserByAccount.get(account.id) ?? null;
    const email = primaryUserId ? userEmailById.get(primaryUserId) ?? null : null;

    return {
      ...account,
      display_name: profile?.display_name ?? null,
      location: locationParts.length > 0 ? locationParts.join(", ") : null,
      email,
    };
  });
}

export async function getAccountDetails(
  accountId: string,
): Promise<{ success: boolean; data?: AccountDetails; error?: string }> {
  noStore();
  const supabase = getSupabaseAdminClient();

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select(
      "id, name, role, account_type, status, sector, created_at, updated_at, stripe_connect_status, stripe_connect_account_id, stripe_connect_onboarded_at",
    )
    .eq("id", accountId)
    .single();

  if (accountError || !account) {
    return { success: false, error: accountError?.message ?? "Account not found." };
  }

  const [{ data: publicProfile }, { data: privateProfile }, { data: memberships, error: membershipsError }] =
    await Promise.all([
      supabase
        .from("account_profiles_public")
        .select("display_name, about, website_url, seo_slug, public_fields_json")
        .eq("account_id", accountId)
        .maybeSingle(),
      supabase
        .from("account_profiles_private")
        .select("addresses_json, ops_json, tax_registered, tax_id, company_number, billing_address, created_at, updated_at")
        .eq("account_id", accountId)
        .maybeSingle(),
      supabase
        .from("account_memberships")
        .select("user_id, membership_role, is_primary, created_at")
        .eq("account_id", accountId)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
    ]);

  if (membershipsError) {
    return { success: false, error: membershipsError.message };
  }

  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
  let userById = new Map<
    string,
    {
      email: string;
      full_name: string | null;
      phone_number: string | null;
      position: string | null;
      status: AccountStatus | null;
    }
  >();

  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, email, full_name, phone_number, position, status")
      .in("id", userIds);

    if (usersError) {
      return { success: false, error: usersError.message };
    }

    userById = new Map(
      (users ?? []).map((u) => [
        u.id,
        {
          email: u.email,
          full_name: u.full_name,
          phone_number: u.phone_number,
          position: u.position,
          status: u.status,
        },
      ]),
    );
  }

  const members: AccountMemberDetails[] = (memberships ?? []).map((membership) => {
    const user = userById.get(membership.user_id);

    return {
      user_id: membership.user_id,
      membership_role: membership.membership_role,
      is_primary: membership.is_primary,
      joined_at: membership.created_at,
      email: user?.email ?? null,
      full_name: user?.full_name ?? null,
      phone_number: user?.phone_number ?? null,
      position: user?.position ?? null,
      status: user?.status ?? null,
    };
  });

  return {
    success: true,
    data: {
      account,
      publicProfile,
      privateProfile,
      members,
    },
  };
}

/**
 * Fetch the primary user email + name for an account via account_memberships.
 * Returns null if no member or auth email is found.
 */
async function getAccountRecipient(
  accountId: string,
): Promise<{ email: string; name: string } | null> {
  const supabase = getSupabaseAdminClient();

  // account_memberships.user_id = public.users.id
  // public.users.auth_user_id = auth.users.id
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
    .select("auth_user_id, full_name, email")
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

export async function updateAccountStatus(
  accountId: string,
  status: string
): Promise<{ success: boolean; error?: string; emailSent?: boolean; emailError?: string }> {
  const supabase = getSupabaseAdminClient();

  // Fetch current account state before updating (for approval email)
  const { data: account } = await supabase
    .from("accounts")
    .select("name, role, status")
    .eq("id", accountId)
    .single();

  // Update the account status.
  const { error: accountError } = await supabase
    .from("accounts")
    .update({ status: status as never })
    .eq("id", accountId);

  if (accountError) {
    return { success: false, error: accountError.message };
  }

  // Keep every linked user's status aligned with the account.
  const { data: memberships, error: membershipError } = await supabase
    .from("account_memberships")
    .select("user_id")
    .eq("account_id", accountId);

  if (membershipError) {
    return { success: false, error: membershipError.message };
  }

  const userIds = [...new Set((memberships ?? []).map((membership) => membership.user_id))];
  if (userIds.length > 0) {
    const { error: userError } = await supabase
      .from("users")
      .update({ status: status as never })
      .in("id", userIds);

    if (userError) {
      return { success: false, error: userError.message };
    }
  }

  // Auto-send approval email when transitioning to "approved"
  const isApproval = status === "approved" && account?.status !== "approved";
  if (isApproval && account) {
    const recipient = await getAccountRecipient(accountId);
    if (recipient) {
      const emailResult = await sendAccountApprovedEmail(recipient.email, {
        recipient_name: recipient.name,
        role: account.role as Enums<"account_role">,
        platform_url: getSiteEnv().siteUrl,
      });
      if (!emailResult.success) {
        // Account was approved — report email failure separately so the admin knows
        return {
          success: true,
          emailSent: false,
          emailError: emailResult.detail ?? emailResult.error,
        };
      }
      return { success: true, emailSent: true };
    }
    // No recipient found — approved OK, but couldn't send email
    return { success: true, emailSent: false, emailError: "No email address on file" };
  }

  return { success: true };
}

export async function updateAccountRole(
  accountId: string,
  role: AccountRole,
): Promise<{ success: boolean; error?: string; unchanged?: boolean }> {
  if (!accountId) {
    return { success: false, error: "Account id is required." };
  }

  if (!ACCOUNT_ROLES.includes(role)) {
    return { success: false, error: "Invalid account role." };
  }

  const supabase = getSupabaseAdminClient();

  const { data: currentAccount, error: currentAccountError } = await supabase
    .from("accounts")
    .select("role")
    .eq("id", accountId)
    .single();

  if (currentAccountError || !currentAccount) {
    return { success: false, error: currentAccountError?.message ?? "Account not found." };
  }

  if (currentAccount.role === role) {
    return { success: true, unchanged: true };
  }

  const { error: updateError } = await supabase
    .from("accounts")
    .update({ role: role as never })
    .eq("id", accountId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  return { success: true };
}

export async function deleteAccount(
  accountId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!accountId) {
    return { success: false, error: "Account id is required." };
  }

  const supabase = getSupabaseAdminClient();

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();

  if (accountError) {
    return { success: false, error: accountError.message };
  }

  if (!account) {
    return { success: false, error: "Account not found." };
  }

  const { error: deleteError } = await supabase
    .from("accounts")
    .delete()
    .eq("id", accountId);

  if (deleteError) {
    return {
      success: false,
      error: deleteError.message,
    };
  }

  return { success: true };
}

export async function updateAccountRolesBulk(
  accountIds: string[],
  role: AccountRole,
): Promise<{ success: boolean; error?: string; updatedAccounts?: number }> {
  const uniqueAccountIds = [...new Set(accountIds)].filter(Boolean);

  if (uniqueAccountIds.length === 0) {
    return { success: false, error: "No accounts selected." };
  }

  if (!ACCOUNT_ROLES.includes(role)) {
    return { success: false, error: "Invalid account role." };
  }

  const supabase = getSupabaseAdminClient();

  const { data: updatedAccounts, error: updateError } = await supabase
    .from("accounts")
    .update({ role: role as never })
    .in("id", uniqueAccountIds)
    .select("id");

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  return {
    success: true,
    updatedAccounts: updatedAccounts?.length ?? 0,
  };
}

export async function deleteAccountsBulk(
  accountIds: string[],
): Promise<{ success: boolean; error?: string; deletedAccounts?: number }> {
  const uniqueAccountIds = [...new Set(accountIds)].filter(Boolean);

  if (uniqueAccountIds.length === 0) {
    return { success: false, error: "No accounts selected." };
  }

  const supabase = getSupabaseAdminClient();

  const { data: existingAccounts, error: lookupError } = await supabase
    .from("accounts")
    .select("id")
    .in("id", uniqueAccountIds);

  if (lookupError) {
    return { success: false, error: lookupError.message };
  }

  if (!existingAccounts || existingAccounts.length === 0) {
    return { success: false, error: "No matching accounts found." };
  }

  const existingIds = existingAccounts.map((account) => account.id);

  const { data: deletedAccounts, error: deleteError } = await supabase
    .from("accounts")
    .delete()
    .in("id", existingIds)
    .select("id");

  if (deleteError) {
    return { success: false, error: deleteError.message };
  }

  return {
    success: true,
    deletedAccounts: deletedAccounts?.length ?? 0,
  };
}

export async function updateAccountStatusesBulk(
  accountIds: string[],
  status: Enums<"account_status">,
): Promise<{ success: boolean; error?: string; updatedAccounts?: number; updatedUsers?: number; emailSent?: number; emailFailed?: number }> {
  const uniqueAccountIds = [...new Set(accountIds)];
  if (uniqueAccountIds.length === 0) {
    return { success: false, error: "No accounts selected." };
  }

  const supabase = getSupabaseAdminClient();

  // Fetch current states for approval email detection
  const isApproving = status === "approved";
  let accountsForEmail: { id: string; name: string; role: Enums<"account_role"> }[] = [];

  if (isApproving) {
    const { data: accounts, error: fetchErr } = await supabase
      .from("accounts")
      .select("id, name, role, status")
      .in("id", uniqueAccountIds);

    if (!fetchErr && accounts) {
      accountsForEmail = accounts
        .filter((a) => a.status !== "approved")
        .map((a) => ({ id: a.id, name: a.name, role: a.role }));
    }
  }

  const { data: updatedAccounts, error: accountError } = await supabase
    .from("accounts")
    .update({ status: status as never })
    .in("id", uniqueAccountIds)
    .select("id");

  if (accountError) {
    return { success: false, error: accountError.message };
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("account_memberships")
    .select("user_id")
    .in("account_id", uniqueAccountIds);

  if (membershipError) {
    return { success: false, error: membershipError.message };
  }

  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id).filter(Boolean))];

  if (userIds.length === 0) {
    return {
      success: true,
      updatedAccounts: updatedAccounts?.length ?? 0,
      updatedUsers: 0,
    };
  }

  const { data: updatedUsers, error: userError } = await supabase
    .from("users")
    .update({ status: status as never })
    .in("id", userIds)
    .select("id");

  if (userError) {
    return { success: false, error: userError.message };
  }

  // Send approval emails for accounts that just got approved
  let emailSent = 0;
  let emailFailed = 0;

  if (isApproving && accountsForEmail.length > 0) {
    const siteUrl = getSiteEnv().siteUrl;

    const sendResults = await Promise.all(
      accountsForEmail.map(async (acct) => {
        const recipient = await getAccountRecipient(acct.id);
        if (!recipient) return { sent: false };

        const result = await sendAccountApprovedEmail(recipient.email, {
          recipient_name: recipient.name,
          role: acct.role,
          platform_url: siteUrl,
        });
        return { sent: result.success };
      }),
    );

    for (const r of sendResults) {
      if (r.sent) emailSent++;
      else emailFailed++;
    }
  }

  return {
    success: true,
    updatedAccounts: updatedAccounts?.length ?? 0,
    updatedUsers: updatedUsers?.length ?? 0,
    emailSent,
    emailFailed,
  };
}

export async function sendEmailToAccounts(params: {
  accountIds: string[];
  subject: string;
  body: string;
}): Promise<{ success: boolean; sent: number; failed: number; error?: string }> {
  const { accountIds, subject, body } = params;

  if (!subject.trim() || !body.trim()) {
    return { success: false, sent: 0, failed: 0, error: "Subject and body are required." };
  }

  if (accountIds.length === 0) {
    return { success: false, sent: 0, failed: 0, error: "No recipients selected." };
  }

  let sent = 0;
  let failed = 0;

  for (const accountId of accountIds) {
    const recipient = await getAccountRecipient(accountId);
    if (!recipient) {
      failed++;
      continue;
    }

    const result = await sendAdminMessageEmail(recipient.email, {
      recipient_name: recipient.name,
      subject,
      body,
    });

    if (result.success) {
      sent++;
    } else {
      failed++;
    }
  }

  return {
    success: failed === 0,
    sent,
    failed,
  };
}

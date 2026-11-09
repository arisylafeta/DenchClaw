"use server";

import { unstable_noStore as noStore } from "next/cache";
import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { readRowsInBatches } from "@/lib/platform-admin/queries";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import { refundChargeInFull } from "@/lib/platform-admin/transactions/stripe-refund";
import { sendRefundIssuedEmail, sendSellerCancelledEmail } from "@/lib/platform-admin/transactions/emails";
import {
  refundAndCancelDeal,
  sendCancellationEmails,
  type DealForRefund,
  type RefundAndCancelResult,
  type RefundDeps,
} from "@/lib/platform-admin/transactions/service";
import { refundBlocker, transactionNumber, type TransactionRow } from "@/lib/platform-admin/transactions/contract";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function adminDb() {
  // The copied generated types predate several settlement tables; contain the cast at this boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSupabaseAdminClient() as any;
}

async function requireAdmin(): Promise<string> {
  const user = await currentUser();
  if (!user || !ALLOWED_EMAILS.has(user.email)) throw new Error("Unauthorized");
  return user.email;
}

const num = (value: unknown): number | null => (value == null ? null : Number(value));

async function loadContacts(accountIds: string[]) {
  const db = adminDb();
  const accounts = await readRowsInBatches<Row>(accountIds, (ids) =>
    db.from("accounts").select("id, name, notification_user_id").in("id", ids),
  );
  const memberships = await readRowsInBatches<Row>(accountIds, (ids) =>
    db.from("account_memberships").select("account_id, user_id, is_primary").in("account_id", ids),
  );
  const userIds = [
    ...accounts.map((a) => a.notification_user_id).filter(Boolean),
    ...memberships.map((m) => m.user_id),
  ] as string[];
  const users = await readRowsInBatches<Row>(userIds, (ids) => db.from("users").select("id, email, full_name").in("id", ids));
  const userById = new Map(users.map((u) => [u.id as string, u]));
  const byAccount = new Map<string, { name: string | null; email: string | null; contactName: string | null }>();
  for (const account of accounts) {
    const member = memberships
      .filter((m) => m.account_id === account.id)
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0];
    const user = userById.get(account.notification_user_id ?? "") ?? userById.get(member?.user_id ?? "");
    byAccount.set(account.id, { name: account.name ?? null, email: user?.email ?? null, contactName: user?.full_name ?? account.name ?? null });
  }
  return byAccount;
}

export async function getTransactions(): Promise<TransactionRow[]> {
  noStore();
  await requireAdmin();
  const db = adminDb();
  const { data: deals, error } = await db
    .from("deals")
    .select(
      "id, status, workflow_step, source_type, quantity, agreed_amount, agreed_currency, listing_id, counterparty_account_id, supplier_account_id, created_at, listing_title:snapshot_json->>listing_title, listing_reference:snapshot_json->>listing_reference",
    )
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  const dealRows = (deals ?? []) as Row[];
  const dealIds = dealRows.map((d) => d.id as string);

  const listingIds = dealRows.map((d) => d.listing_id as string);
  const [settlements, intents, contacts, listings, specs, payouts] = await Promise.all([
    readRowsInBatches<Row>(dealIds, (ids) =>
      db.from("deal_settlements").select("deal_id, payment_status, payout_status, funded_amount, refunded_amount, paid_out_amount, currency").in("deal_id", ids),
    ),
    readRowsInBatches<Row>(dealIds, (ids) =>
      db.from("deal_payment_intents").select("deal_id, provider_ref, status, payment_purpose").in("deal_id", ids),
    ),
    loadContacts(dealRows.flatMap((d) => [d.counterparty_account_id, d.supplier_account_id]).filter(Boolean)),
    readRowsInBatches<Row>(listingIds, (ids) => db.from("listings").select("id, listing_kind").in("id", ids)),
    readRowsInBatches<Row>(listingIds, (ids) => db.from("listing_specs").select("listing_id, quantity, quantity_available").in("listing_id", ids)),
    readRowsInBatches<Row>(dealIds, (ids) => db.from("deal_payouts").select("deal_id").in("deal_id", ids)),
  ]);
  const kindByListing = new Map(listings.map((l) => [l.id as string, l.listing_kind as string]));
  const specsByListing = new Map(specs.map((x) => [x.listing_id as string, x]));
  const payoutCount = new Map<string, number>();
  for (const payout of payouts) payoutCount.set(payout.deal_id, (payoutCount.get(payout.deal_id) ?? 0) + 1);
  const capturedCount = new Map<string, number>();
  for (const intent of intents) if (intent.status === "captured") capturedCount.set(intent.deal_id, (capturedCount.get(intent.deal_id) ?? 0) + 1);
  const settlementByDeal = new Map(settlements.map((s) => [s.deal_id as string, s]));
  const intentByDeal = new Map<string, Row>();
  for (const intent of intents) {
    if (intent.payment_purpose === "initial" || !intentByDeal.has(intent.deal_id)) intentByDeal.set(intent.deal_id, intent);
  }

  return dealRows.map((deal) => {
    const settlement = settlementByDeal.get(deal.id);
    const intent = intentByDeal.get(deal.id);
    const row = {
      status: deal.status as string,
      paymentStatus: (settlement?.payment_status ?? null) as string | null,
      payoutStatus: (settlement?.payout_status ?? null) as string | null,
      fundedAmount: num(settlement?.funded_amount),
      refundedAmount: num(settlement?.refunded_amount),
      paidOutAmount: num(settlement?.paid_out_amount),
      paymentIntentRef: (intent?.status === "captured" ? intent.provider_ref : null) as string | null,
      dealQuantity: Number(deal.quantity ?? 0),
      listingKind: kindByListing.get(deal.listing_id) ?? null,
      specsQuantity: num(specsByListing.get(deal.listing_id)?.quantity),
      specsAvailable: num(specsByListing.get(deal.listing_id)?.quantity_available),
      payoutRows: payoutCount.get(deal.id) ?? 0,
      capturedPayments: capturedCount.get(deal.id) ?? 0,
    };
    const blocker = refundBlocker(row);
    return {
      id: deal.id,
      number: transactionNumber(deal.id),
      createdAt: deal.created_at,
      workflowStep: deal.workflow_step,
      sourceType: deal.source_type,
      quantity: Number(deal.quantity ?? 1),
      amount: Number(deal.agreed_amount ?? 0),
      currency: deal.agreed_currency ?? "GBP",
      listingId: deal.listing_id,
      listingTitle: deal.listing_title ?? null,
      listingReference: deal.listing_reference ?? null,
      buyerName: contacts.get(deal.counterparty_account_id)?.name ?? null,
      sellerName: contacts.get(deal.supplier_account_id)?.name ?? null,
      status: row.status,
      paymentStatus: row.paymentStatus,
      payoutStatus: row.payoutStatus,
      fundedAmount: row.fundedAmount,
      refundedAmount: row.refundedAmount,
      paidOutAmount: row.paidOutAmount,
      paymentIntentRef: row.paymentIntentRef,
      canRefund: blocker === null,
      refundBlocker: blocker,
    } satisfies TransactionRow;
  });
}

async function loadDealForRefund(dealId: string): Promise<DealForRefund | null> {
  const db = adminDb();
  const { data: deal, error: dealError } = await db
    .from("deals")
    .select("id, status, workflow_step, quantity, listing_id, agreed_currency, counterparty_account_id, supplier_account_id, listing_title:snapshot_json->>listing_title, listing_reference:snapshot_json->>listing_reference")
    .eq("id", dealId)
    .maybeSingle();
  if (dealError) throw new Error(`Could not read the transaction: ${dealError.message}`);
  if (!deal) return null;
  const [{ data: settlement }, { data: intents }, contacts, { data: listing }, { data: spec }, { data: payoutRows }] = await Promise.all([
    db.from("deal_settlements").select("payment_status, payout_status, funded_amount, refunded_amount, paid_out_amount, currency, funding_payment_intent_id").eq("deal_id", dealId).maybeSingle(),
    db.from("deal_payment_intents").select("id, provider_ref, stripe_charge_id, status").eq("deal_id", dealId),
    loadContacts([deal.counterparty_account_id, deal.supplier_account_id].filter(Boolean)),
    db.from("listings").select("listing_kind").eq("id", deal.listing_id).maybeSingle(),
    db.from("listing_specs").select("quantity, quantity_available").eq("listing_id", deal.listing_id).maybeSingle(),
    db.from("deal_payouts").select("id").eq("deal_id", dealId),
  ]);
  const intent = ((intents ?? []) as Row[]).find((i) => i.id === settlement?.funding_payment_intent_id && i.status === "captured");
  const buyer = contacts.get(deal.counterparty_account_id);
  const seller = contacts.get(deal.supplier_account_id);
  return {
    id: deal.id,
    status: deal.status,
    workflowStep: deal.workflow_step,
    currency: (settlement?.currency ?? deal.agreed_currency ?? "GBP") as string,
    listingTitle: deal.listing_title ?? "your order",
    listingReference: deal.listing_reference ?? null,
    fundedAmount: num(settlement?.funded_amount),
    refundedAmount: num(settlement?.refunded_amount),
    paidOutAmount: num(settlement?.paid_out_amount),
    paymentStatus: settlement?.payment_status ?? null,
    payoutStatus: settlement?.payout_status ?? null,
    dealQuantity: Number(deal.quantity ?? 0),
    listingKind: listing?.listing_kind ?? null,
    specsQuantity: num(spec?.quantity),
    specsAvailable: num(spec?.quantity_available),
    payoutRows: ((payoutRows ?? []) as Row[]).length,
    capturedPayments: ((intents ?? []) as Row[]).filter((i) => i.status === "captured").length,
    chargeId: intent?.stripe_charge_id ?? null,
    paymentIntentRef: intent?.provider_ref ?? null,
    buyer: { email: buyer?.email ?? null, name: buyer?.contactName ?? null },
    seller: { email: seller?.email ?? null, name: seller?.contactName ?? null },
  };
}

function deps(): RefundDeps {
  const db = adminDb();
  return {
    actorHasPlatformUser: async (email) => {
      const { data } = await db.from("users").select("id").ilike("email", email).limit(1);
      return Boolean(data?.length);
    },
    loadDeal: loadDealForRefund,
    refundCharge: async (input) => {
      const refund = await refundChargeInFull(input);
      return { id: refund.id, amount: refund.amount, currency: refund.currency, created: refund.created };
    },
    finalize: async ({ dealId, refund, actorEmail, reason }) => {
      const { data, error } = await db.rpc("admin_cancel_refunded_deal", {
        p_deal_id: dealId,
        p_refund_provider_ref: refund.id,
        p_refund_amount_minor: refund.amount,
        p_currency: refund.currency.toUpperCase(),
        p_refund_created_at: new Date(refund.created * 1000).toISOString(),
        p_actor_email: actorEmail,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      const result = data as Row;
      if (result.outcome === "not_eligible") return { outcome: "not_eligible", blocker: String(result.blocker) };
      return { outcome: result.outcome, restoredQuantity: result.restored_quantity };
    },
    sendBuyer: sendRefundIssuedEmail,
    sendSeller: sendSellerCancelledEmail,
    audit: async (dealId, action, payload) => {
      const { error } = await db.from("audit_events").insert({ actor_user_id: null, entity_type: "deal", entity_id: dealId, action, payload_json: payload });
      if (error) console.error(`[transactions] audit event ${action} for ${dealId} failed: ${error.message}`);
    },
  };
}

export async function refundAndCancelTransaction(input: {
  dealId: string;
  confirmation: string;
}): Promise<RefundAndCancelResult> {
  noStore();
  const actorEmail = await requireAdmin();
  return refundAndCancelDeal(deps(), { dealId: input.dealId, confirmation: input.confirmation, actorEmail });
}

/** Resend both emails for a deal this page already cancelled. */
export async function resendCancellationEmailsAction(dealId: string) {
  noStore();
  await requireAdmin();
  const db = adminDb();
  const { data: cancelled } = await db
    .from("audit_events")
    .select("id")
    .eq("entity_type", "deal")
    .eq("entity_id", dealId)
    .eq("action", "deal_cancelled_admin_refund")
    .limit(1);
  if (!cancelled?.length) return { ok: false as const, error: "This deal was not cancelled from the Transactions page" };
  const deal = await loadDealForRefund(dealId);
  if (!deal) return { ok: false as const, error: "Transaction not found" };
  return { ok: true as const, ...(await sendCancellationEmails(deps(), deal)) };
}

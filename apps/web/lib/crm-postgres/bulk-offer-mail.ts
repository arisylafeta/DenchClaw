// The writes and reads behind the Offers tab's outreach: who may be emailed, what facts the draft may use,
// the forward-only stage move after a send, the thread link, and the "No stock" stock line.
//
// The email itself is text, not a record: mail_message holds the draft. This module never sends anything.
import "server-only";
import { queryPg, withPgTransaction } from "../postgres";
import { buildProductKey, type FieldFact, type ProductKey } from "../match/product-key";
import { chaseDue } from "../match/working-days";
import { addressParts, sameName, type BuyerFacts, type RequestFacts } from "../match/offer-email";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const emailIn = (value: string | null | undefined) => (value ?? "").match(EMAIL)?.[0]?.toLowerCase() ?? null;

type OutreachRow = {
  offer_id: string;
  listing_id: string;
  kind: "supply" | "demand";
  stage: string | null;
  offer_name: string | null;
  offer_contact: string | null;
  offer_person_id: string | null;
  offer_company_id: string | null;
  offer_data: Record<string, unknown>;
  listing_party: string | null;
  listing_contact: string | null;
  listing_email: string | null;
  listing_location: string | null;
  listing_person_id: string | null;
  listing_company_id: string | null;
  listing_title: string | null;
  person_name: string | null;
  person_email: string | null;
  person_opted_out: boolean;
  listing_person_name: string | null;
  /** The buyer or seller company on the listing, by name: never in the copy. */
  listing_company_name: string | null;
  /** The recipient's company, so a person row named after it ("ro cell") is not read as a first name. */
  offer_company_name: string | null;
  buyer_company_id: string | null;
};

type RequestRow = {
  product_family: string | null; volume: string | number | null; volume_unit: string | null; quantity: string | null;
  needed_by: string | null; spec: Record<string, unknown> | null; max_price: string | number | null;
};

type BuyerProfileRow = { buyer_profile: Record<string, unknown> | null };

export type OfferOutreach = {
  offerId: string;
  listingId: string;
  kind: "supply" | "demand";
  stage: string | null;
  data: Record<string, unknown>;
  /** The listing's location as written, for the template to reduce to town and country. */
  location: string | null;
  /** Where the draft goes. Null when the offer holds no address; `blocked` then says why. */
  email: string | null;
  recipientFirstName: string | null;
  /** A plain reason this contact must not be emailed, or null. */
  blocked: string | null;
  /** Values that must never appear in the copy: the other party, their contact details and the exact address. */
  privateValues: string[];
  product: { key: ProductKey; fields: FieldFact[] };
  buyer: BuyerFacts | null;
  /** On a request: its product, quantity, timing and spec from `crm_bulk_demand`, for the stock ask. */
  request: RequestFacts | null;
  lastSent: { sent_at: string; subject: string | null } | null;
  openDraftId: string | null;
  /** True when the last email has gone unanswered for three working days. */
  chaseDue: boolean;
};

const asText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

async function outreachRow(listingId: string, offerId: string): Promise<OutreachRow | null> {
  const [row] = await queryPg<OutreachRow>(
    `select o.id as offer_id, o.bulk_listing_id as listing_id, l.kind, o.stage, o.name as offer_name, o.contact as offer_contact,
       o.person_id as offer_person_id, o.company_id as offer_company_id, o.data as offer_data,
       l.party as listing_party, l.contact as listing_contact, l.email as listing_email, l.location as listing_location,
       l.person_id as listing_person_id, l.company_id as listing_company_id,
       p.full_name as person_name, p.email as person_email, coalesce(p.email_opted_out, false) as person_opted_out,
       lp.full_name as listing_person_name, lc.name as listing_company_name, oc.name as offer_company_name,
       coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', '')) as listing_title,
       case when l.kind = 'demand' then l.company_id else o.company_id end as buyer_company_id
     from crm_bulk_offers o
     join crm_bulk_listings l on l.id = o.bulk_listing_id
     left join crm_people p on p.id = o.person_id
     left join crm_people lp on lp.id = l.person_id
     left join crm_companies lc on lc.id = l.company_id
     left join crm_companies oc on oc.id = o.company_id
     where o.id = $2 and o.role = 'counterparty' and (o.bulk_listing_id = $1 or o.counterpart_id = $1)`,
    [listingId, offerId]);
  return row ?? null;
}

/** The contact an offer email would go to, with the server-side reasons it must not. */
export async function offerContactReason(row: OutreachRow): Promise<{ email: string | null; blocked: string | null }> {
  const email = emailIn(row.offer_contact) ?? emailIn(row.person_email);
  if (!email) {
    return { email: null, blocked: "This offer has no email address yet. Add one to the contact first." };
  }
  if (row.person_opted_out) {
    return { email, blocked: "This contact has opted out of email." };
  }
  const [suppression] = await queryPg<{ reason: string }>(
    `select reason from mail_suppression where email = lower($1) limit 1`, [email]);
  if (suppression) {
    return { email, blocked: `This address is on the do-not-send list (${suppression.reason}).` };
  }
  return { email, blocked: null };
}

function privateValuesFor(row: OutreachRow): string[] {
  // The other party is the listing's own side, never the recipient. The town and country may be named; the street,
  // unit and postcode may not. The whole location string must not go in the list: firstLeak matches word by word,
  // so it would forbid the town the template is allowed to print. A short company name is kept: firstLeak matches it
  // as a whole word.
  const values = [
    row.listing_party, row.listing_contact, row.listing_email, row.listing_person_name, row.listing_company_name,
    ...addressParts(row.listing_location),
  ];
  return values.map((value) => (value ?? "").trim()).filter(Boolean);
}

/**
 * Everything a draft for this offer may say, read once. The product key is built exactly as the Matches tab
 * builds it, so the email and the ranked list cannot disagree about the lot.
 */
export async function offerOutreach(listingId: string, offerId: string, now: Date = new Date()): Promise<OfferOutreach | null> {
  const row = await outreachRow(listingId, offerId);
  if (!row) {
    return null;
  }
  const [fields, contact, lastSent, buyer, request] = await Promise.all([
    queryPg<FieldFact>(
      `select field_key, value, status, visibility, coalesce(alternatives, '[]'::jsonb) as alternatives
       from crm_bulk_listing_fields where bulk_listing_id = $1`, [row.listing_id]),
    offerContactReason(row),
    queryPg<{ sent_at: string; subject: string | null; replied_at: string | null }>(
      `select sent_at::text, subject, replied_at::text from crm_bulk_offer_mail where offer_id = $1 order by sent_at desc limit 1`, [offerId]),
    buyerFacts(row.buyer_company_id),
    row.kind === "demand" ? requestFacts(row.listing_id) : Promise.resolve(null),
  ]);
  const key = buildProductKey({ fields, title: row.listing_title });
  const openDraftId = asText(row.offer_data.open_draft_id);
  return {
    offerId: row.offer_id,
    listingId: row.listing_id,
    kind: row.kind,
    stage: row.stage,
    data: row.offer_data ?? {},
    location: asText(row.listing_location),
    email: contact.email,
    recipientFirstName: firstNameOf(row),
    blocked: contact.blocked,
    privateValues: privateValuesFor(row),
    product: { key, fields },
    buyer,
    request,
    lastSent: lastSent[0] ? { sent_at: lastSent[0].sent_at, subject: lastSent[0].subject } : null,
    openDraftId,
    // A chase is only due while the last email is unanswered, exactly as `chaseOffers` reads it.
    chaseDue: !!lastSent[0] && !lastSent[0].replied_at && chaseDue(lastSent[0].sent_at, now),
  };
}

/** The buyer's own want, from `buyer_profile`: the dossier products and the derived wants text. */
async function buyerFacts(companyId: string | null): Promise<BuyerFacts | null> {
  if (!companyId) {
    return null;
  }
  const [row] = await queryPg<BuyerProfileRow>(`select buyer_profile from crm_companies where id = $1`, [companyId]);
  const profile = row?.buyer_profile ?? null;
  if (!profile) {
    return null;
  }
  const dossier = profile.dossier && typeof profile.dossier === "object" ? profile.dossier as Record<string, unknown> : null;
  return { wants: asText(profile.wants), products: dossier?.products ?? null };
}

/** A request's own facts. Requests have no field rows; their product, quantity and timing live on the demand row. */
async function requestFacts(listingId: string): Promise<RequestFacts | null> {
  const [row] = await queryPg<RequestRow>(
    `select product_family, volume, volume_unit, quantity, needed_by::text as needed_by, spec, max_price
     from crm_bulk_demand where id = $1`, [listingId]);
  if (!row) {
    return null;
  }
  const num = (value: string | number | null) => (value == null || value === "" ? null : Number(value));
  return {
    productFamily: row.product_family, volume: num(row.volume), volumeUnit: row.volume_unit, quantity: row.quantity,
    neededBy: row.needed_by, spec: row.spec ?? {}, maxPrice: num(row.max_price),
  };
}

/**
 * The recipient's first name: the person's, else the offer's name when the offer has no company (an offer with a
 * company is named after it). A person named after their company ("ro cell" at Ro Cell) has no first name.
 */
function firstNameOf(row: Pick<OutreachRow, "person_name" | "offer_name" | "offer_company_id" | "offer_company_name">): string | null {
  const text = (row.person_name ?? (row.offer_company_id ? null : row.offer_name) ?? "").trim();
  if (!text || text.includes("@") || sameName(text, row.offer_company_name)) {
    return null;
  }
  // The greeting checks the word is a name; here it only must not be the company.
  return text.split(/[\s,]+/)[0] ?? null;
}

/**
 * A send is a touch and, from candidate only, a move to offered. Never backwards: an offer that has already
 * moved on (negotiating, signed, declined) keeps its stage. The open draft is cleared either way.
 */
export async function markOfferSent(offerId: string, actorUserId: string | null): Promise<{ moved: boolean; stage: string | null } | null> {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query<{ stage: string | null; bulk_listing_id: string; person_id: string | null; name: string | null }>(
      `select stage, bulk_listing_id, person_id, name from crm_bulk_offers where id = $1 for update`, [offerId]);
    const offer = rows[0];
    if (!offer) {
      return null;
    }
    if (offer.stage === "candidate" || offer.stage === "offered") {
      await client.query(
        `update crm_bulk_offers set
           stage = case when stage = 'candidate' then 'offered' else stage end,
           last_touch_on = current_date, last_touch_via = 'mail',
           data = data - 'open_draft_id', updated_at = now()
         where id = $1`, [offerId]);
    } else {
      await client.query(`update crm_bulk_offers set data = data - 'open_draft_id', updated_at = now() where id = $1`, [offerId]);
    }
    const moved = offer.stage === "candidate";
    if (moved) {
      await client.query(
        `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, data, actor_user_id)
         values ($1, $2, $3, 'status', $4, $5::jsonb, $6)`,
        [offer.bulk_listing_id, offerId, offer.person_id, `${offer.name ?? "Offer"} · Offered`,
          JSON.stringify({ from: "candidate", stage: "offered", source: "offer_email_sent" }), actorUserId]);
    }
    return { moved, stage: moved ? "offered" : offer.stage };
  });
}

/** Records the draft that is open in the panel, so the same one is reopened instead of a second copy. */
export async function setOpenDraft(offerId: string, draftId: string | null): Promise<void> {
  await queryPg(
    `update crm_bulk_offers set data = case when $2::text is null then data - 'open_draft_id'
       else data || jsonb_build_object('open_draft_id', $2::text) end, updated_at = now() where id = $1`,
    [offerId, draftId]);
}

/** A confirmed link between the sent thread, the listing and the offer. A proposed link is never enough. */
export async function linkOfferThread(listingId: string, offerId: string, threadId: string, actorEmail: string): Promise<void> {
  await queryPg(
    `insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, offer_id, confidence, state, reason, labelled_by, confirmed_by, confirmed_at)
     values ('mail', $1, $2, $3, 'high', 'confirmed', 'Offer email sent from the Offers tab', $4, $4, now())
     on conflict (channel, thread_id, bulk_listing_id, coalesce(offer_id, ''))
     do update set state = 'confirmed', confirmed_by = excluded.confirmed_by, confirmed_at = now(), reason = excluded.reason`,
    [threadId, listingId, offerId, actorEmail]);
}

/**
 * "No stock" on a request: the linked stock line is gone at the source, so exactly that row is marked stale.
 * Nothing else is touched, and without the link nothing is marked. A listing-side offer gets a suggestion only.
 */
export async function markNoStock(
  listingId: string, offerId: string, kind: "supply" | "demand", actorUserId: string | null,
): Promise<{ marked: string | null; suggestion: string | null }> {
  if (kind !== "demand") {
    return { marked: null, suggestion: "The buyer said no stock. Close the listing when every offer has come back." };
  }
  const [row] = await queryPg<{ stock_id: string | null }>(
    `select data->>'stock_opportunity_id' as stock_id from crm_bulk_offers where id = $1 and bulk_listing_id = $2`, [offerId, listingId]);
  const stockId = asText(row?.stock_id);
  if (!stockId) {
    return { marked: null, suggestion: null };
  }
  return withPgTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; title: string }>(
      `update crm_stock_opportunities
       set status = 'stale',
           details = details || jsonb_build_object('stale', jsonb_build_object('reason', 'No stock', 'offer_id', $2::text, 'at', now())),
           updated_at = now()
       where id = $1 and status in ('opportunity', 'listed') returning id, title`, [stockId, offerId]);
    const row = rows[0];
    if (!row) {
      return { marked: null, suggestion: null };
    }
    await client.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, body, data, actor_user_id)
       values ($1, $2, (select person_id from crm_bulk_offers where id = $2), 'status', $3, $4, $5::jsonb, $6)`,
      [listingId, offerId, `No stock: ${row.title} marked stale`, "The supplier said there is no stock, so the linked stock line is stale.",
        JSON.stringify({ stock_opportunity_id: row.id, status: "stale" }), actorUserId]);
    return { marked: row.id, suggestion: null };
  });
}

/** Offers on this listing that were sent and have gone unanswered long enough to chase, newest send first. */
export async function chaseOffers(listingId: string, now: Date = new Date()): Promise<{ offerId: string; sentAt: string }[]> {
  const rows = await queryPg<{ offer_id: string; sent_at: string }>(
    `select o.id as offer_id, m.sent_at::text
     from crm_bulk_offers o
     join lateral (select sent_at, replied_at from crm_bulk_offer_mail where offer_id = o.id order by sent_at desc limit 1) m on true
     where (o.bulk_listing_id = $1 or o.counterpart_id = $1) and o.role = 'counterparty' and o.stage = 'offered'
       and m.replied_at is null
     order by m.sent_at desc`, [listingId]);
  return rows.filter((row) => chaseDue(row.sent_at, now)).map((row) => ({ offerId: row.offer_id, sentAt: row.sent_at }));
}

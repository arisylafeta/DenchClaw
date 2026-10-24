"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, ClipboardList, FileText, History, MessageCircle } from "lucide-react";
import type { BulkListingView } from "@/lib/bulk-listing";
import type { TradeField } from "@/lib/bulk-trade-details";
import type { TradeKind } from "@/lib/bulk-trades";
import type { ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { supplyFacts } from "@/lib/listing-facts";
import { BusyRegion, ShBlock } from "./bt-shimmer";
import { ErrorText, request } from "./trade-ui";
import { SheetTabs } from "./demand-page";
import { ListingHeader } from "./listing-header";
import { PartyCard, type PartyPerson } from "./party-card";
import { ListingConversation, type ListingMail } from "./listing-conversation";
import { ListingDetails } from "./listing-details";
import { useRegistry } from "./use-registry";
import { OffersTab } from "./offers-tab";
import { DocumentsTab } from "./documents-tab";
import { MatchaTab } from "./matcha-tab";
import { DemandActions } from "./demand-actions";
import css from "./demand-header.module.css";

type Context = { person?: PartyPerson | null; mail: ListingMail[] };
const TABS = ["Details", "Matcha", "Offers", "Documents", "History"];
const ICONS = { Details: ClipboardList, Matcha: MessageCircle, Offers: ArrowLeftRight, Documents: FileText, History };

export function SupplyListingPanel({ listing, today, onChanged, onClose, onOpenListing }: {
  listing: BulkListingView; today: string; onChanged: () => void; onClose: () => void; onOpenListing: (id: string) => void;
}) {
  const [tab, setTab] = useState("Details");
  const [context, setContext] = useState<Context | null>(null);
  const [conversation, setConversation] = useState<ThreadEntry[] | null | undefined>();
  // A failed read of the labelled threads must not fall back to unrelated seller mail: say so instead.
  const [conversationFailed, setConversationFailed] = useState(false);
  const [fields, setFields] = useState<TradeField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registry = useRegistry();
  const endpoint = `/api/bulk-listings/${encodeURIComponent(listing.id)}`;
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12_000);
    const options = { signal: abort.signal };
    setContext(null); setConversation(undefined); setConversationFailed(false); setFields(null); setError(null);
    void Promise.allSettled([
      request<Context>(`${endpoint}/context`, options).then((r) => { if (live) setContext({ person: r.person ?? null, mail: Array.isArray(r.mail) ? r.mail : [] }); }).catch(() => { if (live) setContext({ mail: [] }); }),
      request<{ conversation: ThreadEntry[] | null }>(`${endpoint}/conversation`, options).then((r) => { if (live) setConversation(r.conversation ?? null); }).catch(() => { if (live) { setConversation([]); setConversationFailed(true); } }),
      request<{ fields: TradeField[] }>(`${endpoint}/fields`, options).then((r) => { if (live) setFields(r.fields); }).catch((err) => { if (live) { setFields([]); setError(err instanceof Error ? err.message : "Could not load details."); } }),
    ]).finally(() => clearTimeout(timer));
    return () => { live = false; abort.abort(); clearTimeout(timer); };
  }, [endpoint, listing.updated_at]);
  const kind = listing.context.trade_kind ?? listing.spec.trade_kind;
  const typedFacts = registry && typeof kind === "string" && Object.hasOwn(registry.fields, kind) && fields
    ? supplyFacts(registry, kind as TradeKind, fields) : [];
  // Some listings predate a stored product kind. Preserve their recorded fields using the registry templates.
  const facts = typedFacts.length || !registry || !fields ? typedFacts : Array.from(new Map(
    Object.keys(registry.fields).flatMap((key) => supplyFacts(registry, key as TradeKind, fields))
      .filter((fact) => fields.some((field) => field.field_key === fact.key)).map((fact) => [fact.key, fact]),
  ).values());
  const busy = context === null || conversation === undefined || fields === null;
  return <div role="region" aria-label="Supply listing detail" className={`${css.panel} flex w-full min-w-0 flex-col gap-3`}>
    <div className={css.card}><ListingHeader listing={listing} onBack={onClose} /><SheetTabs tabs={TABS} icons={ICONS} centered value={tab} onChange={setTab} /></div>
    {tab === "Details" && <BusyRegion busy={busy} label="Loading supply details" className="flex w-full min-w-0 flex-col gap-6">
      <PartyCard loading={context === null} role="Seller" name={listing.party} companyId={listing.company_id} personId={listing.person_id} person={context?.person ?? null} contact={listing.contact} email={listing.email}>
        <section aria-label={`Conversation with ${listing.party}`}><h3 className="mb-3 text-[13px] font-semibold">Conversation with {listing.party}</h3>
          {conversationFailed && <ErrorText error="Could not load the conversation. Reload to try again." />}
          <ListingConversation subject="listing" mail={context?.mail ?? []} conversation={conversation ?? null} loading={context === null || conversation === undefined} />
        </section>
      </PartyCard>
      <ErrorText error={error} />
      {fields === null || !registry ? <ShBlock on size={32} /> : <ListingDetails facts={facts} />}
    </BusyRegion>}
    <MatchaTab listingId={listing.id} active={tab === "Matcha"} />
    {tab === "Offers" && <OffersTab demandId={listing.id} listingId={listing.id} onChanged={onChanged} />}
    {tab === "Documents" && <DocumentsTab listingId={listing.id} />}
    {tab === "History" && <DemandActions story section="Activity" activityEndpoint={endpoint} demand={{ id: listing.id, status: listing.status }} today={today} onChanged={onChanged} onClose={onClose} onEdit={() => {}} onOpenTrade={onOpenListing} onOpenSupply={onOpenListing} />}
  </div>;
}

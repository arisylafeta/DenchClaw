"use client";

import { ArrowLeftRight, ChevronDown, Combine, ChevronRight, ClipboardList, ExternalLink, FileText, History, Mail, MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { BusyRegion } from "./bt-shimmer";
import type { Registry } from "@/lib/bulk-registry";
import { useRegistry } from "./use-registry";
import { ListingDetails } from "./listing-details";
import { demandFacts } from "@/lib/listing-facts";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import type { BuyerProfile, BuyerEngagement } from "@/lib/buyer-profile";
import { buildEntryLink } from "@/lib/workspace-links";
import { request } from "./trade-ui";
import { SheetTabs, rowFocus } from "./demand-page";
import { DemandActions } from "./demand-actions";
import { CompanyContext } from "./company-context";
import { BuyerContext } from "./buyer-context";
import { OffersTab } from "./offers-tab";
import type { ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { DemandHeader } from "./demand-header";
import { PartyCard, type PartyPerson } from "./party-card";
import { BuyerCardBody, BuyerStatus } from "./buyer-card";
import { buyerCard, type PricePoint } from "@/lib/buyer-card";
import { ListingConversation } from "./listing-conversation";
import { DocumentsTab } from "./documents-tab";
import { MatchaTab } from "./matcha-tab";
import { DemandMatchesTab } from "./demand-matches-tab";
import css from "./demand-panel.module.css";
import headerCss from "./demand-header.module.css";

type BuyerMail = { id: string; thread_id: string | null; direction: "inbound" | "outbound"; subject: string | null; preview: string | null; body?: string | null; from_email: string | null; at: string };
type BuyerContext = {
  buyer: { profile: BuyerProfile | undefined; engagement: BuyerEngagement | null; demand: Demand[] } | null;
  mail: BuyerMail[];
  person?: PartyPerson | null;
  /** Prices other buyers paid us, for the benchmark. */
  market?: PricePoint[];
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : shortDate(iso.slice(0, 10));
};

/** Facts the pack table already says per pack, so the single-value cells are left out when it is shown. */
const PACK_COVERED = ["product_family", "capacity", "chemistries", "formats", "makes", "origins"];

/** The ask, field by field: what is filled, plus the gaps that block a deal. Then the buyer's own words. */
function TheAsk({ demand, loading }: { demand: Demand; loading: boolean }) {
  const registry = useRegistry();
  // Core demand facts do not need the attribute registry to be readable.
  const factRegistry = registry ?? { specLists: {}, specLabels: {}, specGroups: {}, specNumbers: {} } as Registry;
  const packs = demand.context?.packs ?? [];
  return (
    <div className="flex flex-col gap-4">
      <ListingDetails packs={packs} loading={loading ? [!demand.product_family && !packs.length && "product_family", !packs.length && demand.spec?.kwh_min == null && demand.spec?.kwh_max == null && "capacity"].filter((key): key is string => !!key) : false} facts={demandFacts(factRegistry, demand).filter((fact) => !packs.length || !PACK_COVERED.includes(fact.key)).map((fact) => fact.key === "capacity" ? { ...fact, critical: true } : fact)} />
      {demand.qualify_question && (
        <p className="text-[13px]"><span style={{ color: "var(--bt-muted)" }}>Question to ask: </span>{demand.qualify_question}
          {demand.qualify_asked_on && <span className={css.note}> · sent {shortDate(demand.qualify_asked_on)}</span>}</p>
      )}
    </div>
  );
}

/** The buyer as a compact person card, like the CRM person page: who they are and where they stand. */
function TheBuyer({ demand, context, onOpenDemand, thread }: { demand: Demand; context: BuyerContext | null; onOpenDemand?: (id: string) => void; thread?: React.ReactNode }) {
  const profile = context?.buyer?.profile;
  const engagement = context?.buyer?.engagement;
  const others = (context?.buyer?.demand ?? []).filter((d) => d.id !== demand.id && d.status !== "closed");
  const stage = [profile?.tier ? `${profile.tier}-tier` : null, profile?.stage ? (profile.tier ? profile.stage.toLowerCase() : profile.stage) : null].filter(Boolean).join(" ") || null;
  const card = context ? buyerCard({ profile, engagement, request: { product_family: demand.product_family, wants: demand.wants }, market: context.market ?? [] }) : null;
  return (
    <PartyCard loading={context === null} role="Buyer" name={demand.buyer} companyId={demand.company_id} personId={demand.person_id} person={context?.person ?? null}
      contact={demand.contact} email={demand.email}
      status={context ? <BuyerStatus stage={stage} lastHeard={engagement?.last_heard_at ? ago(engagement.last_heard_at) : null} card={card} /> : null}
      body={<BuyerCardBody card={card} loading={context === null} profileHref={demand.company_id ? buildEntryLink("company", demand.company_id) : null}
        related={others.map((d) => ({ id: d.id, label: d.product_family ?? d.wants.slice(0, 48), onOpen: onOpenDemand ? () => onOpenDemand(d.id) : undefined }))} />}>
      {thread}
    </PartyCard>
  );
}

const TABS = ["Details", "Matches", "Matcha", "Offers", "Documents", "History"];
const TAB_ICONS = { Details: ClipboardList, Matches: Combine, Matcha: MessageCircle, Documents: FileText, Offers: ArrowLeftRight, History: History };

export function PreviewDemandPanel({ demand, today, onChanged, onClose, onOpenTrade, onOpenSupply, onOpenDemand, isTrade = false, waiting = null, ownerPicker = null }: {
  ownerPicker?: React.ReactNode;
  isTrade?: boolean; waiting?: { waiting_on: "us" | "them" | null; waiting_since: string | null } | null;
  demand: Demand;
  today: string;
  onChanged: () => void;
  onClose: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  onOpenDemand?: (id: string) => void;
}) {
  // Opens on the details; history (what was asked, said and done) comes last.
  const [tab, setTab] = useState("Details");
  const [context, setContext] = useState<BuyerContext | null>(null);
  const [conversation, setConversation] = useState<ThreadEntry[] | null | undefined>(undefined);
  const endpoint = `/api/bulk-listings/${encodeURIComponent(demand.id)}`;
  useEffect(() => {
    let cancelled = false;
    setContext(null);
    setConversation(undefined);
    void request<{ conversation: ThreadEntry[] | null }>(`${endpoint}/conversation`).then((r) => { if (!cancelled) setConversation(Array.isArray(r?.conversation) ? r.conversation : null); }).catch(() => { if (!cancelled) setConversation(null); });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12_000);
    void request<BuyerContext>(`${endpoint}/context`, { signal: abort.signal }).finally(() => clearTimeout(timer)).then((c) => { if (!cancelled) setContext({ buyer: c?.buyer ?? null, mail: Array.isArray(c?.mail) ? c.mail : [], person: c?.person ?? null }); }).catch(() => { if (!cancelled) setContext({ buyer: null, mail: [] }); });
    return () => { cancelled = true; };
  }, [endpoint]);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView?.({ block: "start" }); }, [demand.id]);
  const actions = (section: string) => (
    <DemandActions story activityEndpoint={endpoint} section={section} demand={demand} today={today} onChanged={onChanged} onClose={onClose}
      onEdit={() => {}} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
  );
  return (
    <div ref={top} role="region" aria-label="Demand detail" className={`${headerCss.panel} flex w-full min-w-0 flex-col gap-3`}>
      <BusyRegion busy={context === null} label="Loading demand details" className="flex w-full min-w-0 flex-col gap-3">
      <div className={headerCss.card}>
        <DemandHeader isTrade={isTrade} waiting={waiting} ownerPicker={ownerPicker} demand={demand} supply={null} loadingSupply={false} actions={actions("Overview")} onBack={onClose} />
        <SheetTabs
          tabs={TABS}
          icons={TAB_ICONS}
          centered
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "Details" && (
        <div data-preview-details className="flex w-full flex-col gap-6">
          <TheBuyer demand={demand} context={context} onOpenDemand={onOpenDemand}
            thread={<ListingConversation mail={context?.mail ?? []} conversation={conversation ?? null} loading={context === null || conversation === undefined} />} />
          <TheAsk demand={demand} loading={false} />
        </div>
      )}
      <DemandMatchesTab demandId={demand.id} active={tab === "Matches"} onOpenOffers={() => setTab("Offers")} />
      <MatchaTab listingId={demand.id} active={tab === "Matcha"} />
      {tab === "Documents" && <DocumentsTab listingId={demand.id} />}
      {tab === "Offers" && <OffersTab listingId={demand.id} demandId={demand.id} request onChanged={onChanged} />}
      {tab === "History" && (
        <div className="flex w-full flex-col gap-6">
          {actions("Activity")}
        </div>
      )}
      </BusyRegion>
    </div>
  );
}

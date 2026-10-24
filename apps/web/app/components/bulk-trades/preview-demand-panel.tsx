"use client";

import { ArrowLeftRight, ChevronDown, Combine, ChevronRight, ClipboardList, ExternalLink, FileText, History, Mail, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { BusyRegion, Sh } from "./bt-shimmer";
import type { Registry } from "@/lib/bulk-registry";
import { useRegistry } from "./use-registry";
import { ListingDetails } from "./listing-details";
import { demandFacts } from "@/lib/listing-facts";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import type { BuyerProfile, BuyerEngagement } from "@/lib/buyer-profile";
import type { DemandSupply } from "@/lib/demand-supply-types";
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
import { ListingConversation } from "./listing-conversation";
import { DocumentsTab } from "./documents-tab";
import { SupplyTab } from "./demand-supply-tab";
import type { SupplyUnitView } from "@/lib/demand-supply-types";
import css from "./demand-panel.module.css";
import headerCss from "./demand-header.module.css";

type BuyerMail = { id: string; thread_id: string | null; direction: "inbound" | "outbound"; subject: string | null; preview: string | null; body?: string | null; from_email: string | null; at: string };
type BuyerContext = {
  buyer: { profile: BuyerProfile | undefined; engagement: BuyerEngagement | null; demand: Demand[] } | null;
  mail: BuyerMail[];
  person?: PartyPerson | null;
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : shortDate(iso.slice(0, 10));
};

/** Facts the pack table already says per pack, so the single-value cells are left out when it is shown. */
const PACK_COVERED = ["product_family", "capacity", "chemistries", "formats", "makes", "origins"];

/** The ask, field by field: what is filled, plus the gaps that block a deal. Then the buyer's own words. */
function TheAsk({ demand, supply, loading }: { demand: Demand; supply: DemandSupply | null; loading: boolean }) {
  const registry = useRegistry();
  // Core demand facts do not need the attribute registry to be readable.
  const factRegistry = registry ?? { specLists: {}, specLabels: {}, specGroups: {}, specNumbers: {} } as Registry;
  const packs = demand.context?.packs ?? [];
  return (
    <div className="flex flex-col gap-4">
      <ListingDetails packs={packs} loading={loading ? [!demand.product_family && !packs.length && "product_family", !packs.length && demand.spec?.kwh_min == null && demand.spec?.kwh_max == null && "capacity"].filter((key): key is string => !!key) : false} facts={demandFacts(factRegistry, demand, { pinned: supply?.requirement.pinned }).filter((fact) => !packs.length || !PACK_COVERED.includes(fact.key)).map((fact) => fact.key === "capacity" ? { ...fact, critical: true } : fact)} />
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
  const stage = [profile?.tier ? `${profile.tier}-tier` : null, profile?.stage].filter(Boolean).join(" · ");
  const glance = [
    stage ? { label: "Stage", value: stage } : null,
    profile?.owner ? { label: "Owner", value: profile.owner } : null,
    engagement?.last_heard_at ? { label: "Last heard", value: ago(engagement.last_heard_at) } : null,
  ].filter((item) => item !== null);
  const notes = [
    profile?.buyer_profile?.wants ? { label: "Usually buys", value: profile.buyer_profile.wants } : null,
    profile?.outreach_notes ? { label: "Notes", value: profile.outreach_notes } : null,
    profile?.past_issues ? { label: "Past issues", value: profile.past_issues, bad: true } : null,
  ].filter((note) => note !== null);
  return (
    <PartyCard loading={context === null} role="Buyer" name={demand.buyer} companyId={demand.company_id} personId={demand.person_id} person={context?.person ?? null}
      contact={demand.contact} email={demand.email} glance={glance} notes={notes}
      related={{ label: "Also asking for", items: others.map((d) => ({ id: d.id, label: d.product_family ?? d.wants.slice(0, 48), onOpen: onOpenDemand ? () => onOpenDemand(d.id) : undefined })) }}>
      {thread}
    </PartyCard>
  );
}

const TABS = ["Details", "Matches", "Offers", "Documents", "History"];
const TAB_ICONS = { Details: ClipboardList, Matches: Combine, Documents: FileText, Offers: ArrowLeftRight, History: History };

export function PreviewDemandPanel({ demand, today, onChanged, onClose, onOpenTrade, onOpenSupply, onOpenDemand, isTrade = false }: {
  isTrade?: boolean;
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
  const [supply, setSupply] = useState<DemandSupply | null>(null);
  const [supplyLoading, setSupplyLoading] = useState(true);
  const supplySequence = useRef(0);
  const [context, setContext] = useState<BuyerContext | null>(null);
  const [conversation, setConversation] = useState<ThreadEntry[] | null | undefined>(undefined);
  const endpoint = `/api/bulk-listings/${encodeURIComponent(demand.id)}`;
  const loadSupply = useCallback(async () => {
    const sequence = ++supplySequence.current;
    setSupplyLoading(true);
    // Inventory matching can be slow; never shimmer for ever: give up after 12s and show what the demand itself says.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12_000);
    try {
      const result = await request<DemandSupply>(`/api/bulk-trades/demand/${encodeURIComponent(demand.id)}/supply`, { signal: abort.signal });
      if (!Array.isArray(result?.groups)) throw new Error("Could not check inventory.");
      if (sequence === supplySequence.current) setSupply(result);
    } catch {
      if (sequence === supplySequence.current) setSupply(null);
    } finally {
      clearTimeout(timer);
      if (sequence === supplySequence.current) setSupplyLoading(false);
    }
  }, [endpoint]);
  useEffect(() => { void loadSupply(); return () => { supplySequence.current++; }; }, [loadSupply, demand.updated_at]);
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
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  // Same verdicts as the Bulk Trades supply matching tab: shortlist, not a fit, or clear.
  async function verdict(unit: SupplyUnitView, value: "shortlist" | "not_a_fit" | "clear") {
    setMatchBusy(true);
    setMatchError(null);
    try {
      await request(`/api/bulk-trades/demand/${encodeURIComponent(demand.id)}/supply`, { method: "POST", body: JSON.stringify({
        key: unit.key, verdict: value, title: [unit.make, unit.model].filter(Boolean).join(" ") || unit.title, seller: unit.seller,
        eurPerKwh: unit.eurPerKwh, href: unit.href,
      }) });
      await loadSupply();
      onChanged();
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setMatchBusy(false);
    }
  }
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView?.({ block: "start" }); }, [demand.id]);
  const actions = (section: string) => (
    <DemandActions story activityEndpoint={endpoint} section={section} demand={demand} today={today} onChanged={onChanged} onClose={onClose}
      onEdit={() => {}} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
  );
  return (
    <div ref={top} role="region" aria-label="Demand detail" className={`${headerCss.panel} flex w-full min-w-0 flex-col gap-3`}>
      <BusyRegion busy={supplyLoading || context === null} label="Loading demand details" className="flex w-full min-w-0 flex-col gap-3">
      <div className={headerCss.card}>
        <DemandHeader isTrade={isTrade} demand={demand} supply={supply} loadingSupply={supplyLoading} actions={actions("Overview")} onBack={onClose} />
        <SheetTabs
          tabs={TABS}
          icons={TAB_ICONS}
          centered
          labels={supply?.totalGroups ? { Matches: `Matches · ${supply.totalGroups}` } : undefined}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "Details" && (
        <div data-preview-details className="flex w-full flex-col gap-6">
          <TheBuyer demand={demand} context={context} onOpenDemand={onOpenDemand}
            thread={<ListingConversation mail={context?.mail ?? []} conversation={conversation ?? null} loading={context === null || conversation === undefined} />} />
          <TheAsk demand={demand} supply={supply} loading={supplyLoading} />
        </div>
      )}
      {tab === "Matches" && (
        <SupplyTab supply={supply} loading={supplyLoading} error={supply || supplyLoading ? null : "Could not check inventory."}
          onVerdict={verdict} busy={matchBusy} leads={[]} />
      )}
      {tab === "Matches" && matchError && <p className="text-[13px]" style={{ color: "var(--bt-red)" }}>{matchError}</p>}
      {tab === "Documents" && <DocumentsTab listingId={demand.id} />}
      {tab === "Offers" && <OffersTab listingId={demand.id} demandId={demand.id} onChanged={onChanged} />}
      {tab === "History" && (
        <div className="flex w-full flex-col gap-6">
          {actions("Activity")}
        </div>
      )}
      </BusyRegion>
    </div>
  );
}

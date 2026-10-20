"use client";

import { ArrowLeftRight, ClipboardList, FileText, History } from "lucide-react";
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
import { DemandHeader } from "./demand-header";
import { PartyCard, type PartyPerson } from "./party-card";
import { DocumentsTab } from "./documents-tab";
import css from "./demand-panel.module.css";
import headerCss from "./demand-header.module.css";

type BuyerMail = { id: string; direction: "inbound" | "outbound"; subject: string | null; preview: string | null; from_email: string | null; at: string };
type BuyerContext = {
  buyer: { profile: BuyerProfile | undefined; engagement: BuyerEngagement | null; demand: Demand[] } | null;
  mail: BuyerMail[];
  person?: PartyPerson | null;
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : shortDate(iso.slice(0, 10));
};

/** The ask, field by field: what is filled, plus the gaps that block a deal. Then the buyer's own words. */
function TheAsk({ demand, supply, loading }: { demand: Demand; supply: DemandSupply | null; loading: boolean }) {
  const registry = useRegistry();
  // Core demand facts do not need the attribute registry to be readable.
  const factRegistry = registry ?? { specLists: {}, specLabels: {}, specGroups: {}, specNumbers: {} } as Registry;
  return (
    <div className="flex flex-col gap-4">
      <ListingDetails loading={loading ? [!demand.product_family && "product_family", demand.spec?.kwh_min == null && demand.spec?.kwh_max == null && "capacity"].filter((key): key is string => !!key) : false} facts={demandFacts(factRegistry, demand, { pinned: supply?.requirement.pinned }).map((fact) => fact.key === "capacity" ? { ...fact, critical: true } : fact)} />
      {demand.qualify_question && (
        <p className="text-[13px]"><span style={{ color: "var(--bt-muted)" }}>Question to ask: </span>{demand.qualify_question}
          {demand.qualify_asked_on && <span className={css.note}> · sent {shortDate(demand.qualify_asked_on)}</span>}</p>
      )}
    </div>
  );
}

/** The buyer as a compact person card, like the CRM person page: who they are and where they stand. */
function TheBuyer({ demand, context, onOpenDemand }: { demand: Demand; context: BuyerContext | null; onOpenDemand?: (id: string) => void }) {
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
      related={{ label: "Also asking for", items: others.map((d) => ({ id: d.id, label: d.product_family ?? d.wants.slice(0, 48), onOpen: onOpenDemand ? () => onOpenDemand(d.id) : undefined })) }} />
  );
}

function MailList({ mail, loading = false }: { mail: BuyerMail[]; loading?: boolean }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className={css.label}>Email with the buyer</h3>
      {mail.map((m) => (
        <div key={m.id} className={css.mail}>
          <span className={css.dir}>{m.direction === "inbound" ? "In" : "Out"}</span>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between gap-2"><strong className="truncate">{m.subject ?? "(no subject)"}</strong><span className={`${css.note} shrink-0`}>{ago(m.at)}</span></div>
            {m.preview && <p className={`${css.note} truncate`}>{m.preview}</p>}
          </div>
        </div>
      ))}
      {loading && <div className={css.mail}><span className={css.dir}><Sh on chars={3} /></span><div className="min-w-0 flex-1"><strong><Sh on chars={28} /></strong><p className={css.note}><Sh on chars={36} /></p></div></div>}
      {!loading && !mail.length && <p className={css.note}>No email with this buyer in your mailbox.</p>}
    </section>
  );
}

const TABS = ["Details", "Offers", "Documents", "History"];
const TAB_ICONS = { Details: ClipboardList, Documents: FileText, Offers: ArrowLeftRight, History: History };

export function PreviewDemandPanel({ demand, today, onChanged, onClose, onOpenTrade, onOpenSupply, onOpenDemand }: {
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
  const endpoint = `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`;
  const loadSupply = useCallback(async () => {
    const sequence = ++supplySequence.current;
    setSupplyLoading(true);
    try {
      const result = await request<DemandSupply>(`${endpoint}/supply`);
      if (!Array.isArray(result?.groups)) throw new Error("Could not check inventory.");
      if (sequence === supplySequence.current) setSupply(result);
    } catch {
      if (sequence === supplySequence.current) setSupply(null);
    } finally {
      if (sequence === supplySequence.current) setSupplyLoading(false);
    }
  }, [endpoint]);
  useEffect(() => { void loadSupply(); return () => { supplySequence.current++; }; }, [loadSupply, demand.updated_at]);
  useEffect(() => {
    let cancelled = false;
    setContext(null);
    void request<BuyerContext>(`${endpoint}/context`).then((c) => { if (!cancelled) setContext({ buyer: c?.buyer ?? null, mail: Array.isArray(c?.mail) ? c.mail : [], person: c?.person ?? null }); }).catch(() => { if (!cancelled) setContext({ buyer: null, mail: [] }); });
    return () => { cancelled = true; };
  }, [endpoint]);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView?.({ block: "start" }); }, [demand.id]);
  const actions = (section: string) => (
    <DemandActions story section={section} demand={demand} today={today} onChanged={onChanged} onClose={onClose}
      onEdit={() => {}} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
  );
  return (
    <div ref={top} role="region" aria-label="Demand detail" className={`${headerCss.panel} flex w-full min-w-0 flex-col gap-3`}>
      <BusyRegion busy={supplyLoading || context === null} label="Loading demand details" className="flex w-full min-w-0 flex-col gap-3">
      <div className={headerCss.card}>
        <DemandHeader demand={demand} supply={supply} loadingSupply={supplyLoading} actions={actions("Overview")} onBack={onClose} />
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
          <TheBuyer demand={demand} context={context} onOpenDemand={onOpenDemand} />
          <TheAsk demand={demand} supply={supply} loading={supplyLoading} />
        </div>
      )}
      {tab === "Documents" && <DocumentsTab listingId={demand.id} wantsRequired={false} />}
      {tab === "Offers" && <OffersTab demandId={demand.id} supply={supply} onChanged={onChanged} />}
      {tab === "History" && (
        <div className="flex w-full flex-col gap-6">
          {actions("Activity")}
          {context === null && <MailList mail={[]} loading />}
          {(context?.mail ?? []).length > 0 && (
            <details>
              <summary className="cursor-pointer text-[13px]" style={{ color: "var(--bt-muted)" }}>
                Recent email with this buyer ({context!.mail.length}). Not matched to this request.
              </summary>
              <div className="mt-3"><MailList mail={context!.mail} /></div>
            </details>
          )}
        </div>
      )}
      </BusyRegion>
    </div>
  );
}

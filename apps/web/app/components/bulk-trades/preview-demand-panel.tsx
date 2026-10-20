"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { useRegistry } from "./use-registry";
import { ListingDetails } from "./listing-details";
import { demandFacts } from "@/lib/listing-facts";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import type { BuyerProfile, BuyerEngagement } from "@/lib/buyer-profile";
import type { DemandSupply, MarketLead, SupplyUnitView } from "@/lib/demand-supply-types";
import { buildEntryLink } from "@/lib/workspace-links";
import { ErrorText, request } from "./trade-ui";
import { SheetTabs, rowFocus } from "./demand-page";
import { DemandActions } from "./demand-actions";
import { CompanyContext } from "./company-context";
import { BuyerContext } from "./buyer-context";
import { SupplyTab } from "./demand-supply-tab";
import { DemandHeader } from "./demand-header";
import { PartyCard, type PartyCardProps } from "./party-card";
import css from "./demand-panel.module.css";
import headerCss from "./demand-header.module.css";

type BuyerMail = { id: string; direction: "inbound" | "outbound"; subject: string | null; preview: string | null; from_email: string | null; at: string };
type BuyerContext = {
  buyer: { profile: BuyerProfile | undefined; engagement: BuyerEngagement | null; demand: Demand[] } | null;
  mail: BuyerMail[];
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : shortDate(iso.slice(0, 10));
};

/** The ask, field by field: what is filled, plus the gaps that block a deal. Then the buyer's own words. */
function TheAsk({ demand, supply }: { demand: Demand; supply: DemandSupply | null }) {
  const registry = useRegistry();
  return (
    <section className="flex flex-col gap-3">
      <h3 className={css.label}>The ask</h3>
      {registry
        ? <ListingDetails facts={demandFacts(registry, demand, { pinned: supply?.requirement.pinned })} />
        : <p className={css.note}>Loading…</p>}
      {demand.qualify_question && (
        <p className="text-[13px]"><span style={{ color: "var(--bt-muted)" }}>Question to ask: </span>{demand.qualify_question}
          {demand.qualify_asked_on && <span className={css.note}> · sent {shortDate(demand.qualify_asked_on)}</span>}</p>
      )}
      {demand.source_quote && (
        <p className="text-[13px]">
          “{demand.source_quote}”{" "}
          <span className={css.note}>
            {[demand.source_label?.split(" · ")[0], demand.observed_on ? shortDate(demand.observed_on) : null].filter(Boolean).join(", ")}
            {demand.source_url && <> · <a href={demand.source_url} target="_blank" rel="noreferrer" className="underline">open</a></>}
          </span>
        </p>
      )}
      {demand.note && (
        <details className="text-[13px]">
          <summary className="cursor-pointer" style={{ color: "var(--bt-muted)" }}>Internal notes</summary>
          <p className="mt-2 whitespace-pre-wrap">{demand.note}</p>
        </details>
      )}
    </section>
  );
}

/** The buyer as a card: who they are and where they stand, with a way into the CRM. */
function TheBuyer({ demand, context, onOpenDemand }: { demand: Demand; context: BuyerContext | null; onOpenDemand?: (id: string) => void }) {
  const profile = context?.buyer?.profile;
  const engagement = context?.buyer?.engagement;
  const others = (context?.buyer?.demand ?? []).filter((d) => d.id !== demand.id && d.status !== "closed");
  const chips = [
    profile?.tier ? { label: `${profile.tier}-tier`, tone: "tier" as const } : null,
    profile?.stage ? { label: profile.stage } : null,
    profile?.owner ? { label: `Owner ${profile.owner}` } : null,
  ].filter((chip): chip is { label: string; tone?: "tier" } => !!chip);
  const rows: (PartyCardProps["rows"] extends (infer R)[] | undefined ? R | null : never)[] = [
    engagement?.last_heard_at ? { label: "Last heard", value: ago(engagement.last_heard_at) } : null,
    profile?.buyer_profile?.wants ? { label: "Usually buys", value: profile.buyer_profile.wants } : null,
    others.length > 0 ? {
      label: "Also asking for",
      value: others.map((d, i) => (
        <span key={d.id}>{i > 0 && ", "}
          {onOpenDemand ? <button type="button" className={`${rowFocus} underline`} onClick={() => onOpenDemand(d.id)}>{d.product_family ?? d.wants.slice(0, 48)}</button>
            : d.product_family ?? d.wants.slice(0, 48)}
        </span>
      )),
    } : null,
    profile?.outreach_notes ? { label: "Notes", value: profile.outreach_notes } : null,
    profile?.past_issues ? { label: "Past issues", value: profile.past_issues, bad: true } : null,
  ];
  return (
    <div className="flex flex-col gap-4">
      <PartyCard role="Buyer" name={demand.buyer} companyId={demand.company_id} personId={demand.person_id}
        contact={demand.contact} email={demand.email} chips={chips} rows={rows.filter((row) => row !== null)} />
      <CompanyContext notes={demand.context_notes} />
    </div>
  );
}

function MailList({ mail }: { mail: BuyerMail[] }) {
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
      {!mail.length && <p className={css.note}>No email with this buyer in your mailbox.</p>}
    </section>
  );
}

const TABS = ["Story", "Details", "Supply matching"];

export function PreviewDemandPanel({ demand, today, onChanged, onClose, onOpenTrade, onOpenSupply, onOpenDemand }: {
  demand: Demand;
  today: string;
  onChanged: () => void;
  onClose: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  onOpenDemand?: (id: string) => void;
}) {
  // Opens on the story: what was asked, said and done. Details and matching are reference.
  const [tab, setTab] = useState("Story");
  const [supply, setSupply] = useState<DemandSupply | null>(null);
  const [supplyError, setSupplyError] = useState<string | null>(null);
  const [loadingSupply, setLoadingSupply] = useState(true);
  const [context, setContext] = useState<BuyerContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`;
  const loadSupply = useCallback(async () => {
    setLoadingSupply(true);
    try {
      const result = await request<DemandSupply>(`${endpoint}/supply`);
      if (!Array.isArray(result?.groups)) throw new Error("Could not check inventory.");
      setSupply(result);
      setSupplyError(null);
    } catch (err) {
      setSupplyError(err instanceof Error ? err.message : "Could not check inventory.");
    } finally {
      setLoadingSupply(false);
    }
  }, [endpoint]);
  useEffect(() => { void loadSupply(); }, [loadSupply, demand.updated_at]);
  useEffect(() => {
    let cancelled = false;
    void request<BuyerContext>(`${endpoint}/context`).then((c) => { if (!cancelled) setContext({ buyer: c?.buyer ?? null, mail: Array.isArray(c?.mail) ? c.mail : [] }); }).catch(() => { if (!cancelled) setContext({ buyer: null, mail: [] }); });
    return () => { cancelled = true; };
  }, [endpoint]);
  const leads: MarketLead[] = [];
  async function verdict(unit: SupplyUnitView, value: "shortlist" | "not_a_fit" | "clear") {
    setBusy(true);
    setError(null);
    try {
      await request(`${endpoint}/supply`, { method: "POST", body: JSON.stringify({
        key: unit.key, verdict: value, title: [unit.make, unit.model].filter(Boolean).join(" ") || unit.title, seller: unit.seller,
        eurPerKwh: unit.eurPerKwh, href: unit.href,
      }) });
      await loadSupply();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView?.({ block: "start" }); }, [demand.id]);
  const actions = (section: string) => (
    <DemandActions story section={section} demand={demand} today={today} onChanged={onChanged} onClose={onClose}
      onEdit={() => {}} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
  );
  return (
    <div ref={top} role="region" aria-label="Demand detail" className={`${headerCss.panel} flex w-full min-w-0 flex-col gap-3`}>
      <div className={headerCss.card}>
        <DemandHeader demand={demand} supply={supply} actions={actions("Overview")} onBack={onClose} />
        <SheetTabs
          tabs={TABS}
          labels={{ "Supply matching": supply ? `Matches · ${supply.totalGroups}` : "Matches" }}
          value={tab}
          onChange={setTab}
        />
      </div>
      <ErrorText error={error} />
      {tab === "Details" && (
        <div data-preview-details className={css.details}>
          <div className="flex flex-col gap-6">
            <TheAsk demand={demand} supply={supply} />
          </div>
          <TheBuyer demand={demand} context={context} onOpenDemand={onOpenDemand} />
        </div>
      )}
      {tab === "Supply matching" && (
        <SupplyTab supply={supply} loading={loadingSupply} error={supplyError} onVerdict={verdict} busy={busy} leads={leads} />
      )}
      {tab === "Story" && (
        <div className="flex max-w-[760px] flex-col gap-6">
          {actions("Activity")}
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
    </div>
  );
}

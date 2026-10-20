"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { KIND_LABEL, BASIS_LABEL } from "@/lib/bulk-demand";
import { useRegistry } from "./use-registry";
import { ListingDetails } from "./listing-details";
import { demandFacts } from "@/lib/listing-facts";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import type { BuyerProfile, BuyerEngagement } from "@/lib/buyer-profile";
import type { DemandSupply, MarketLead, SupplyUnitView } from "@/lib/demand-supply-types";
import { buildEntryLink } from "@/lib/workspace-links";
import { ErrorText, request } from "./trade-ui";
import { ChatHint, ScorePill, SheetTabs, rowFocus } from "./demand-page";
import { DemandActions } from "./demand-actions";
import { DemandDialog } from "./demand-editor";
import { CompanyContext } from "./company-context";
import { BuyerContext } from "./buyer-context";
import { SupplyTab } from "./demand-supply-tab";
import styles from "./bulk-detail.module.css";
import css from "./demand-panel.module.css";

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

/** Who the buyer is in three lines. Everything else lives on the company page. */
function TheBuyer({ demand, context, onOpenDemand }: { demand: Demand; context: BuyerContext | null; onOpenDemand?: (id: string) => void }) {
  const profile = context?.buyer?.profile;
  const engagement = context?.buyer?.engagement;
  const others = (context?.buyer?.demand ?? []).filter((d) => d.id !== demand.id && d.status !== "closed");
  const status = [profile?.tier ? `${profile.tier}-tier` : null, profile?.stage, profile?.owner ? `Owner ${profile.owner}` : null,
    engagement?.last_heard_at ? `last heard ${ago(engagement.last_heard_at)}` : null].filter(Boolean);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={css.label}>The buyer</h3>
        {demand.company_id && <a href={buildEntryLink("company", demand.company_id)} className={`${rowFocus} text-[12px] underline`}>Full buyer profile</a>}
      </div>
      {!demand.company_id ? <p className={css.note}>Not linked to a CRM company yet. Link one in Edit.</p> : (
        <>
          {status.length > 0 && <p className="text-[13px]">{status.join(" · ")}</p>}
          {(profile?.buyer_profile?.wants || others.length > 0) && (
            <p className="text-[13px]">
              {profile?.buyer_profile?.wants && <><span style={{ color: "var(--bt-muted)" }}>Usually buys </span>{profile.buyer_profile.wants} </>}
              {others.length > 0 && <span style={{ color: "var(--bt-muted)" }}>Also asking for </span>}
              {others.map((d, i) => (
                <span key={d.id}>{i > 0 && ", "}
                  {onOpenDemand ? <button type="button" className={`${rowFocus} underline`} onClick={() => onOpenDemand(d.id)}>{d.product_family ?? d.wants.slice(0, 48)}</button>
                    : d.product_family ?? d.wants.slice(0, 48)}
                </span>
              ))}
            </p>
          )}
          {profile?.outreach_notes && <p className="text-[13px]">{profile.outreach_notes}</p>}
          {profile?.past_issues && <p className="text-[13px]" style={{ color: "var(--bt-red)" }}>Past issues: {profile.past_issues}</p>}
        </>
      )}
      <CompanyContext notes={demand.context_notes} />
    </section>
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

const TABS = ["Details", "Supply matching", "Activity"];

export function DemandPanel({ demand, today, onChanged, onClose, onOpenTrade, onOpenSupply, onOpenDemand }: {
  demand: Demand;
  today: string;
  onChanged: () => void;
  onClose: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  onOpenDemand?: (id: string) => void;
}) {
  // Opens on the matches: that is why you click into a demand. Details is reference.
  const [tab, setTab] = useState("Supply matching");
  const [editing, setEditing] = useState(false);
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
    <DemandActions section={section} demand={demand} today={today} onChanged={onChanged} onClose={onClose}
      onEdit={() => setEditing(true)} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
  );
  return (
    <div ref={top} role="region" aria-label="Demand detail" className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        <button type="button" onClick={onClose} className={`${rowFocus} hover:underline`}>← Demand</button>
      </nav>
      <header className={css.head}>
        <div className="flex min-w-0 items-start gap-3">
          <ScorePill score={demand.score} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[22px] font-semibold leading-tight">{demand.buyer}</h2>
              {demand.tier && <span className={styles.status}>{demand.tier}-tier</span>}
              {demand.status !== "open" && <span className={styles.status}>{demand.status}</span>}
              {demand.priority && <span className={styles.status} style={{ color: "var(--bt-green)" }}>Priority</span>}
            </div>
            <p className="mt-1 max-w-[80ch] text-[14px] leading-snug">{demand.wants}</p>
            <p className={`${css.meta} mt-1`}>
              <span>{KIND_LABEL[demand.kind]}{demand.basis ? ` · ${BASIS_LABEL[demand.basis]}` : ""}</span>
              {demand.asked_on && <span>Asked {shortDate(demand.asked_on)}</span>}
              {demand.contact && <span>{demand.contact}</span>}
              {demand.fee_eur != null && <span>Fee {formatFee(demand.fee_eur)}</span>}
            </p>
            {demand.waiting && (
              <p className="mt-2 text-[13px]" style={{ color: "var(--bt-amber)" }}>
                {demand.waiting.who ?? "The buyer"} wrote {ago(demand.waiting.since)} and is waiting for our reply.
              </p>
            )}
          </div>
        </div>
        <div className={css.headActions}>{actions("Overview")}</div>
      </header>
      <SheetTabs
        tabs={TABS}
        labels={{ "Supply matching": supply ? `Supply matching · ${supply.totalGroups}` : "Supply matching",
          Activity: demand.activity_count ? `Activity · ${demand.activity_count}` : "Activity" }}
        value={tab}
        onChange={setTab}
      />
      <ErrorText error={error} />
      {tab === "Details" && (
        <div className={css.details}>
          <div className="flex flex-col gap-6">
            <TheAsk demand={demand} supply={supply} />
            <BuyerContext context={demand.context} />
          </div>
          <TheBuyer demand={demand} context={context} onOpenDemand={onOpenDemand} />
        </div>
      )}
      {tab === "Supply matching" && (
        <SupplyTab supply={supply} loading={loadingSupply} error={supplyError} onVerdict={verdict} busy={busy}
          onEdit={() => setEditing(true)} leads={leads} />
      )}
      {tab === "Activity" && (
        <div className="flex max-w-[760px] flex-col gap-6">
          <MailList mail={context?.mail ?? []} />
          {actions("Activity")}
        </div>
      )}
      <ChatHint id={demand.id} />
      {editing && (
        <DemandDialog demand={demand} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />
      )}
    </div>
  );
}

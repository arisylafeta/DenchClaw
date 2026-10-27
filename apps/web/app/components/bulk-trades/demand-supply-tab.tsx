"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { Check as CheckIcon, ChevronDown, ChevronRight, CircleHelp, ExternalLink, Minus, Star, X } from "lucide-react";
import type { Check, SourceKind } from "@/lib/demand-match";
import type { DemandSupply, MarketLead, SellerView, SupplyGroupView, SupplyUnitView } from "@/lib/demand-supply-types";
import { rowFocus } from "./demand-page";
import { buttonClass, buttonStyle } from "./trade-ui";
import css from "./demand-panel.module.css";

export const SOURCE_LABEL: Record<SourceKind, string> = { marketplace: "Marketplace", trade: "Trade", supply: "Supply" };

export const eur = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : `€${n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString("en-GB", { maximumFractionDigits: digits })}`;
export const perKwh = (n: number | null | undefined) => (n == null ? "—" : `€${n < 10 ? n.toFixed(1) : Math.round(n)}/kWh`);
/** Whole counts, shortened once they stop fitting a column: 680,000 → 680k, 10,000,000 → 10M. */
export const count = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 100_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-GB");
/** Seller price per cell, pack or module, for buyers who price per unit rather than per kWh. */
export const perUnit = (n: number | null | undefined, word: string) => (n == null ? "—" : `€${n < 10 ? n.toFixed(2) : Math.round(n)}/${word}`);
const unitNoun = (format: string | null | undefined) => (format === "Cells" ? "cell" : format === "Modules" ? "module" : format === "Systems" ? "system" : "pack");
/** Set when the buyer prices per unit: prices are then shown per cell/pack/module, never derived €/kWh. */
const PerUnit = createContext<string | null>(null);
const priceRange = (kwh: { min: number; max: number } | null, unit: { min: number; max: number } | null, word: string | null) => {
  const r = word ? unit : kwh;
  if (!r) return "No price";
  const f = (n: number) => (word ? perUnit(n, word) : perKwh(n));
  return Math.round(r.min * 100) === Math.round(r.max * 100) ? f(r.min) : `${f(r.min)}–${word ? r.max.toFixed(2) : Math.round(r.max)}`;
};
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const money = (amount: number | null, currency: string | null) =>
  amount == null ? "—" : `${amount.toLocaleString("en-GB", { maximumFractionDigits: amount < 10 ? 2 : 0 })} ${currency ?? ""}`.trim();

/** Exact: everything the buyer specified is confirmed. Check: it fits, but something needs a look. Never a number. */
export function FitBadge({ verdict, label = true }: { verdict: "exact" | "check"; label?: boolean }) {
  const exact = verdict === "exact";
  const text = exact ? "Exact" : "Check";
  return (
    <span className={css.fit} data-verdict={verdict} aria-label={text} title={exact ? "Everything the buyer specified is confirmed" : "Fits, but something is unknown or estimated"}>
      {exact ? <CheckIcon size={12} aria-hidden /> : <CircleHelp size={12} aria-hidden />}
      {label && <span>{text}</span>}
    </span>
  );
}

const CHECK_ICON = { pass: CheckIcon, partial: Minus, unknown: CircleHelp, fail: X };

export function Checks({ checks, compact }: { checks: Check[]; compact?: boolean }) {
  return (
    <div className={css.checks}>
      {checks.map((check) => {
        const Icon = CHECK_ICON[check.state];
        return (
          <span key={check.key} className={css.check} data-state={check.state} title={`${check.label}: ${check.detail}`}>
            <Icon size={11} aria-hidden />
            <span>{compact ? check.label : check.detail}</span>
          </span>
        );
      })}
    </div>
  );
}

function SourceTags({ sources }: { sources: SourceKind[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {sources.map((s) => <span key={s} className={css.tag} data-source={s}>{SOURCE_LABEL[s]}</span>)}
    </span>
  );
}

type Verdict = (unit: SupplyUnitView, verdict: "shortlist" | "not_a_fit" | "clear") => void;

function UnitActions({ unit, onVerdict, busy }: { unit: SupplyUnitView; onVerdict: Verdict; busy: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-pressed={unit.userVerdict === "shortlist"}
        aria-label={unit.userVerdict === "shortlist" ? "Remove from shortlist" : "Shortlist"} title="Shortlist"
        onClick={(event) => { event.stopPropagation(); onVerdict(unit, unit.userVerdict === "shortlist" ? "clear" : "shortlist"); }}>
        <Star size={14} />
      </button>
      <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-label="Not a fit" title="Not a fit"
        onClick={(event) => { event.stopPropagation(); onVerdict(unit, "not_a_fit"); }}>
        <X size={14} />
      </button>
      <a href={unit.href} target={unit.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer"
        className={`${rowFocus} ${css.iconButton}`} aria-label="Open" title="Open" onClick={(event) => event.stopPropagation()}>
        <ExternalLink size={14} />
      </a>
    </span>
  );
}

const evidenceOf = (unit: SupplyUnitView) =>
  [unit.soh != null ? `SOH ${unit.soh}%` : null, unit.photos ? `${unit.photos} photo${unit.photos > 1 ? "s" : ""}` : null,
    unit.year ? String(unit.year) : null, unit.partNumber].filter(Boolean).join(" · ");

/** Packs one by one. Columns nobody filled are left out, and what the header already says is not repeated. */
function UnitTable({ items, more = 0, hideSeller, onVerdict, busy }: {
  items: SupplyUnitView[]; more?: number; hideSeller?: boolean; onVerdict: Verdict; busy: boolean;
}) {
  const perUnitWord = useContext(PerUnit);
  const has = {
    where: items.some((u) => u.country || u.location),
    kwh: items.some((u) => u.kwh != null),
    price: items.some((u) => u.price != null),
    perKwh: items.some((u) => (perUnitWord ? u.eurPerUnit : u.eurPerKwh) != null),
    evidence: items.some((u) => evidenceOf(u) || u.ai),
  };
  const oneSource = new Set(items.map((u) => [u.source, ...u.alsoIn].join("+"))).size === 1;
  return (
    <div className={css.units}>
      <table>
        <thead>
          <tr>
            <th>{hideSeller ? "Pack" : "Seller"}</th>
            {has.where && <th>Where</th>}
            {has.kwh && <th className="r">kWh</th>}
            {has.price && <th className="r">Price</th>}
            {has.perKwh && <th className="r">{perUnitWord ? `€/${perUnitWord}` : "€/kWh"}</th>}
            {has.evidence && <th>Evidence</th>}
            <th className="r"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((unit) => (
            <tr key={unit.key} style={{ opacity: unit.userVerdict === "not_a_fit" ? 0.5 : 1 }}>
              <td>
                {!hideSeller && <div className="font-medium">{unit.seller ?? "Unknown seller"}</div>}
                <div className="max-w-[260px] truncate" title={unit.title}>{unit.title}</div>
                {(!hideSeller || !oneSource || (unit.units ?? 1) > 1) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {(!hideSeller || !oneSource) && <SourceTags sources={[unit.source, ...unit.alsoIn]} />}
                    {unit.units && unit.units > 1 ? <span className={css.note}>{count(unit.units)} units</span> : unit.units == null ? <span className={css.note}>Quantity not stated</span> : null}
                  </div>
                )}
              </td>
              {has.where && <td>{unit.country ?? ""}<div className={`${css.note} max-w-[140px] truncate`} title={unit.location ?? ""}>{unit.location}</div></td>}
              {has.kwh && <td className="r">{unit.kwh == null ? "" : `${unit.kwhEstimated ? "~" : ""}${unit.kwh < 1 ? unit.kwh.toFixed(3) : Math.round(unit.kwh * 10) / 10}`}</td>}
              {has.price && (
                <td className="r">
                  {unit.price == null ? "" : money(unit.price, unit.currency)}
                  {unit.currencyAssumed && unit.price != null && <div className={css.note}>currency assumed</div>}
                </td>
              )}
              {has.perKwh && (
                <td className="r">
                  <strong>{perUnitWord ? (unit.eurPerUnit == null ? "" : perUnit(unit.eurPerUnit, perUnitWord)) : unit.eurPerKwh == null ? "" : perKwh(unit.eurPerKwh)}</strong>
                  {unit.cheapestRank === 0 && unit.peers > 1 && <div style={{ color: "var(--bt-green)" }} className="text-[11px]">Cheapest of {unit.peers}</div>}
                  {unit.marginPct != null && (
                    <div className="text-[11px]" style={{ color: unit.marginPct >= 0 ? "var(--bt-green)" : "var(--bt-red)" }}>
                      {unit.marginPct >= 0 ? `${pct(unit.marginPct)} margin` : `${pct(-unit.marginPct)} over`}
                    </div>
                  )}
                </td>
              )}
              {has.evidence && (
                <td className="max-w-[220px]">
                  {evidenceOf(unit)}
                  {unit.ai && <div className={`${css.note} truncate`} title={unit.ai.reason}>AI: {unit.ai.reason}</div>}
                </td>
              )}
              <td className="r"><UnitActions unit={unit} onVerdict={onVerdict} busy={busy} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <p className={`${css.note} px-3 py-2`}>{more} more, ranked lower.</p>}
    </div>
  );
}

/** One row per seller (one collection each); open a seller to see its packs one by one. */
function SellerList({ sellers, unitWord, onVerdict, busy }: { sellers: SellerView[]; unitWord: string; onVerdict: Verdict; busy: boolean }) {
  const perUnitWord = useContext(PerUnit);
  const [open, setOpen] = useState<string | null>(sellers.length === 1 ? sellers[0].key : null);
  return (
    <div className={css.sellers}>
      {sellers.map((seller) => {
        const isOpen = open === seller.key;
        return (
          <div key={seller.key} className={css.seller}>
            <button type="button" aria-expanded={isOpen} className={`${rowFocus} ${css.sellerRow}`} onClick={() => setOpen(isOpen ? null : seller.key)}>
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{seller.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]" style={{ color: "var(--bt-muted)" }}>
                  <span>{seller.country ?? "Location unknown"}</span>
                  <SourceTags sources={seller.sources} />
                </div>
              </div>
              <span className={css.num}>{seller.units > 0 ? <><strong>{count(seller.units)}</strong><span className={css.numSub}>{unitWord}</span></> : <span className={css.numSub}>Quantity not stated</span>}</span>
              <span className={css.num}>
                {seller.kwh ? (Math.round(seller.kwh.min) === Math.round(seller.kwh.max) ? `${seller.kwh.min < 1 ? `${Math.round(seller.kwh.min * 1000)} Wh` : `${Math.round(seller.kwh.min * 10) / 10} kWh`}` : `${Math.round(seller.kwh.min)}–${Math.round(seller.kwh.max)} kWh`) : "—"}
                <span className={css.numSub}>{seller.withPhotos ? `${seller.withPhotos} with photos` : "no photos"}</span>
              </span>
              <span className={css.num}>
                <strong>{priceRange(seller.eurPerKwh, seller.eurPerUnit, perUnitWord)}</strong>
                <span className={css.numSub}>{seller.totalEur != null ? `${eur(seller.totalEur)}${seller.pricedUnits < seller.units ? ` for ${seller.pricedUnits.toLocaleString("en-GB")}` : " total"}` : ""}</span>
              </span>
              <FitBadge verdict={seller.verdict} />
            </button>
            {isOpen && <UnitTable items={seller.items} more={seller.more} hideSeller onVerdict={onVerdict} busy={busy} />}
          </div>
        );
      })}
    </div>
  );
}

function GroupRow({ group, open, onToggle, onVerdict, busy }: {
  group: SupplyGroupView; open: boolean; onToggle: () => void; onVerdict: Verdict; busy: boolean;
}) {
  const perUnitWord = useContext(PerUnit);
  const countries = [...new Set(group.bySeller.map((u) => u.country).filter(Boolean))];
  const unitWord = group.items[0]?.format === "Cells" ? "cells" : group.items[0]?.format === "Modules" ? "modules" : "packs";
  const covered = group.covers ? group.covers.have >= group.covers.need : null;
  // One seller with one lot (most trades and supply batches): nothing to open, so the row carries the lot itself.
  const lot = group.bySeller.length === 1 && group.items.length === 1 && !group.more && !group.bySeller[0].more ? group.items[0] : null;
  const Row = lot ? "div" : "button";
  return (
    <div className={css.group}>
      <Row {...(lot ? {} : { type: "button" as const, "aria-expanded": open, onClick: onToggle })}
        className={`${lot ? "" : rowFocus} ${css.groupRow} ${lot ? css.groupRowLot : ""}`}>
        <FitBadge verdict={group.verdict} />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{group.label}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>
            <span>
              {group.units > 0 ? `${count(group.units)} ${unitWord}` : "Quantity not stated"} · {group.bySeller.length === 1 ? group.bySeller[0].name : `${group.bySeller.length} sellers`}
              {countries.length ? ` · ${countries.join(", ")}` : ""}
            </span>
            <SourceTags sources={group.sources} />
          </div>
          {group.fill && group.bySeller.length > 1 && (
            <div className="mt-1 text-[12px]">
              <span style={{ color: "var(--bt-muted)" }}>{group.fill.units >= group.fill.need ? `Fewest sellers to fill ${group.fill.need.toLocaleString("en-GB")}: ` : "All sellers together: "}</span>
              <strong>{group.fill.sellers.length} seller{group.fill.sellers.length === 1 ? "" : "s"}</strong>
              {" "}({group.fill.sellers.map((x) => `${x.name} ${x.units.toLocaleString("en-GB")}`).join(" + ")})
              {group.fill.eurPerKwh != null && ` · ~${perKwh(group.fill.eurPerKwh)}`}
            </div>
          )}
          {/* Anything listed passed the basics; only what needs a look gets a chip. */}
          <Checks checks={group.checks.filter((c) => c.key !== "quantity" && c.key !== "price" && c.state !== "pass" && !(lot?.ai && c.detail.startsWith("AI:")))} />
          {lot && (evidenceOf(lot) || lot.ai) && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
              {[evidenceOf(lot), lot.ai ? `AI: ${lot.ai.reason}` : null].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <span className={css.num}>
          <strong style={{ color: covered ? "var(--bt-green)" : undefined }}>
            {group.units === 0 ? "—" : group.covers ? `${count(group.units)} / ${count(group.covers.need)}` : count(group.units)}
          </strong>
          <span className={css.numSub}>{group.units === 0 ? "not stated" : group.covers ? (covered ? "covers ask" : "units") : "units"}</span>
        </span>
        <span className={css.num}>
          <strong>{priceRange(group.eurPerKwh, group.eurPerUnit, perUnitWord)}</strong>
          <span className={css.numSub} style={{ color: group.bestMarginPct == null ? undefined : group.bestMarginPct >= 0 ? "var(--bt-green)" : "var(--bt-red)" }}>
            {group.bestMarginPct == null ? (group.eurPerKwh && group.eurPerKwh.min !== group.eurPerKwh.max && !perUnitWord ? "per kWh" : "") :
              group.bestMarginPct >= 0 ? `up to ${pct(group.bestMarginPct)} margin` : `${pct(-group.bestMarginPct)} over budget`}
          </span>
        </span>
        {lot ? <UnitActions unit={lot} onVerdict={onVerdict} busy={busy} /> : open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </Row>
      {/* One seller: the header already names them, so open straight onto the packs. */}
      {open && !lot && (group.bySeller.length === 1
        ? <UnitTable items={group.bySeller[0].items} more={group.bySeller[0].more} hideSeller onVerdict={onVerdict} busy={busy} />
        : <SellerList sellers={group.bySeller} unitWord={unitWord} onVerdict={onVerdict} busy={busy} />)}
    </div>
  );
}

type SourceFilter = "all" | "marketplace" | "trades" | "starred";
type Sort = "match" | "price" | "units";

export function buyerOffer(units: SupplyUnitView[]): string {
  const lines = units.map((u) => {
    const what = [u.make, u.model].filter(Boolean).join(" ") || u.title;
    const kwh = u.kwh ? ` ${u.kwhEstimated ? "~" : ""}${Math.round(u.kwh * 10) / 10} kWh` : "";
    const extra = [u.chemistry, u.year, u.soh != null ? `SOH ${u.soh}%` : null, u.country].filter(Boolean).join(", ");
    return `- ${u.units && u.units > 1 ? `${u.units} × ` : ""}${what}${kwh}${u.format && u.format !== "Packs" ? ` ${u.format.toLowerCase()}` : ""}${extra ? ` (${extra})` : ""}`;
  });
  return `Available now:\n${lines.join("\n")}`;
}

export function SupplyTab({ supply, loading, error, onVerdict, busy, onEdit, leads }: {
  supply: DemandSupply | null; loading: boolean; error: string | null; onVerdict: Verdict; busy: boolean; onEdit?: () => void;
  leads: MarketLead[];
}) {
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<Sort>("match");
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(5);
  const [showSmall, setShowSmall] = useState(false);
  const [copied, setCopied] = useState(false);
  const groups = useMemo(() => {
    if (!supply) return [];
    if (source === "starred") return [];
    const keep = (u: SupplyUnitView) => source === "all" || (source === "trades" ? u.source === "trade" || u.source === "supply"
      : u.source === source || u.alsoIn.includes(source as SourceKind));
    const list = supply.groups.map((g) => {
      const bySeller = g.bySeller.map((seller) => {
        const items = seller.items.filter(keep);
        return { ...seller, items, units: source === "all" ? seller.units : items.reduce((n, u) => n + (u.units ?? 1), 0) };
      }).filter((seller) => seller.items.length);
      return { ...g, items: g.items.filter(keep), bySeller, units: source === "all" ? g.units : bySeller.reduce((n, x) => n + x.units, 0) };
    }).filter((g) => g.bySeller.length && (showSmall || !g.small));
    if (sort === "price") list.sort((a, b) => (a.eurPerKwh?.min ?? 1e9) - (b.eurPerKwh?.min ?? 1e9));
    if (sort === "units") list.sort((a, b) => b.units - a.units);
    return list;
  }, [supply, source, sort, showSmall]);
  if (loading && !supply) return <p className={css.empty}>Checking marketplace listings and trades…</p>;
  if (error && !supply) return <p role="alert" className={css.empty} style={{ color: "var(--bt-red)" }}>{error}</p>;
  if (!supply) return null;
  const r = supply.requirement;
  const perUnitWord = r.buyerEurPerUnit != null && r.buyerEurPerKwh == null ? unitNoun(groups.flatMap((g) => g.items)[0]?.format) : null;
  const firstOpen = open ?? groups[0]?.key ?? null;
  const checked = supply.considered.marketplace + supply.considered.trades;
  const matchingOn = [...r.pinned, r.unitsNeeded ? `${r.unitsNeeded.toLocaleString("en-GB")} units` : null,
    r.buyerEurPerKwh != null ? `≤ ${perKwh(r.buyerEurPerKwh)}` : null, r.country ? `to ${r.country}` : null].filter(Boolean).join(" · ");
  return (
    <PerUnit.Provider value={perUnitWord}>
    <div className="flex flex-col gap-4">
      <p className={css.note}>
        Matching on {matchingOn || "the ask's wording"}
        {onEdit && <> ·{" "}<button type="button" className={`${rowFocus} underline`} onClick={onEdit}>Edit</button></>}
        {" "}· {checked.toLocaleString("en-GB")} units checked
      </p>
      {supply.errors.map((e) => <p key={e} role="alert" className="text-[12px]" style={{ color: "var(--bt-red)" }}>{e}</p>)}
      {supply.blocked ? <p className={css.empty}>{supply.blocked}</p> : (
        <>
          <div className={css.toolbar}>
            <div role="group" aria-label="Source" className={css.segment}>
              {([["all", "All"], ["marketplace", "Marketplace"], ["trades", "Trades"],
                ...(supply.shortlisted.length ? [["starred", `Shortlisted · ${supply.shortlisted.length}`]] : [])] as [SourceFilter, string][]).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>
              ))}
            </div>
            {source === "starred" ? (
              <button type="button" className={`${rowFocus} ml-auto text-[12px] underline`} onClick={async () => {
                try { await navigator.clipboard.writeText(buyerOffer(supply.shortlisted)); setCopied(true); } catch { setCopied(false); }
              }}>{copied ? "Copied" : "Copy offer for the buyer"}</button>
            ) : (
              <select aria-label="Sort" className="ml-auto border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}
                value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="match">Best match</option>
                <option value="price">Cheapest</option>
                <option value="units">Most units</option>
              </select>
            )}
          </div>
          <div className={css.groups}>
            {source === "starred" && <UnitTable items={supply.shortlisted} onVerdict={onVerdict} busy={busy} />}
            {groups.slice(0, shown).map((group) => (
              <GroupRow key={group.key} group={group} open={firstOpen === group.key} busy={busy} onVerdict={onVerdict}
                onToggle={() => setOpen(firstOpen === group.key ? "" : group.key)} />
            ))}
            {!groups.length && source !== "starred" && <p className={css.empty}>Nothing in our inventory matches{source !== "all" ? " from this source" : ""}.</p>}
          </div>
          {supply.smallGroups > 0 && (
            <button type="button" className={`${rowFocus} self-start text-[12px] underline`} style={{ color: "var(--bt-muted)" }}
              onClick={() => setShowSmall(!showSmall)}>
              {showSmall ? "Hide small lots" : `Show ${supply.smallGroups} small lot${supply.smallGroups === 1 ? "" : "s"} (under 1% of the ask)`}
            </button>
          )}
          {groups.length > shown && (
            <button type="button" className={`${buttonClass} self-start`} style={buttonStyle} onClick={() => setShown(shown + 10)}>
              Show {Math.min(10, groups.length - shown)} more of {groups.length - shown}
            </button>
          )}
        </>
      )}
      {leads.length > 0 && <MarketSection leads={leads} />}
    </div>
    </PerUnit.Provider>
  );
}

/** Sellers outside our inventory. Ari's finder fills `leads`; shown only when there are some. */
function MarketSection({ leads }: { leads: MarketLead[] }) {
  return (
    <section className="mt-4 flex flex-col gap-2">
      <h3 className={css.label}>In the market</h3>
      <div className={css.groups}>
        {leads.map((lead) => (
          <div key={lead.id} className={css.groupRow} style={{ gridTemplateColumns: "minmax(0,1fr) 90px 110px" }}>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold">{lead.company}</div>
              <div className={css.note}>{lead.signal}{lead.country ? ` · ${lead.country}` : ""}</div>
            </div>
            <span className={css.num}>{lead.units ?? "—"}<span className={css.numSub}>units</span></span>
            <span className={css.num}>{lead.status === "new" ? "Ask to buy" : lead.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

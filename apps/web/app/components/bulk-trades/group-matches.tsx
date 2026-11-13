"use client";

// Group matches on a request with several pack types (mock-up "Group matches", 12 Nov 2026): what the buyer needs,
// each type found against its need, then one row per supplier with every matching pack type they hold. The rows are
// the ones Per battery shows, turned round (lib/match/supplier-groups.ts), so the two tabs always agree.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LineCoverage, MatchOffer, SupplierMatch, SupplierStock } from "@/lib/matches-types";
import type { OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { offerDate, STAGE_LABEL } from "./request-matches";
import css from "./request-matches.module.css";

const LINE_LOOK = { fits: { glyph: "✓", cls: css.mOk }, close: { glyph: "≈", cls: css.mClose }, misses: { glyph: "✗", cls: css.mMiss } } as const;

/** What the buyer needs: each pack type, confirmed and maybe stock found against the need, across every supplier. */
export function NeedsCard({ lines, buyer, onEdit }: { lines: LineCoverage[]; buyer: string; onEdit?: () => void }) {
  const total = (() => {
    const min = lines.reduce((n, l) => n + l.qtyMin, 0);
    const max = lines.reduce((n, l) => n + (l.qtyMax ?? l.qtyMin), 0);
    return max > min ? `${min.toLocaleString("en-GB")}–${max.toLocaleString("en-GB")}` : min.toLocaleString("en-GB");
  })();
  return (
    <section className={`${css.card} ${css.summary}`} aria-label={`What ${buyer} needs`}>
      <div className={css.needsHead}>
        <span className={css.secTitle}>What {buyer} needs <span className={css.muted}>· {lines.length} pack types, {total} packs</span></span>
        {onEdit && <button type="button" className={css.linkbtn} onClick={onEdit}>Edit pack types</button>}
      </div>
      <ul className={css.needs}>
        {lines.map((line) => {
          const look = LINE_LOOK[line.state];
          const confirmed = line.found - line.close;
          return (
            <li key={line.id} className={`${css.need} ${css[`need_${line.state}`]}`}>
              <b>{line.label}</b>
              <span className={css.muted}>Need {line.need}</span>
              <span className={`${css.needFound} ${look.cls}`}><i aria-hidden>{look.glyph}</i> {confirmed.toLocaleString("en-GB")} found
                <span className="sr-only">{line.state === "fits" ? ": enough" : line.state === "close" ? ": not enough yet" : ": none"}</span></span>
              <span className={css.muted}>
                {line.close > 0 ? `+ ${line.close} maybe (capacity or pack not confirmed) · ` : ""}
                {line.suppliers ? `${line.suppliers} ${line.suppliers === 1 ? "supplier" : "suppliers"}` : "Nothing found yet"}
              </span>
            </li>
          );
        })}
      </ul>
      <span className={css.muted}>Only stated quantities count. Stock that matches the request but none of these types is under each supplier as Other matching stock.</span>
    </section>
  );
}

/** Where a supplier stands: in Offers (with the chase) or not yet. */
function standing(offer: MatchOffer | null): { text: string; due: boolean } {
  if (!offer) return { text: "Not contacted", due: false };
  const stage = STAGE_LABEL[offer.stage as OfferStage] ?? offer.stage;
  return { text: `In offers · ${stage} ${offerDate(offer.date)}`.trim(), due: !!offer.chaseDue };
}

const COVER_CLS = { fits: css.mOk, close: css.mClose, none: css.mUnk } as const;

function StockBlock({ stock }: { stock: SupplierStock }) {
  const mark = stock.lineState === "fits" ? "✓" : stock.lineState === "close" ? "≈" : null;
  return (
    <li className={css.sStock}>
      <div className={css.sStockTitle}>
        <b>{stock.pack}</b>
        <b>× {stock.stated ? stock.count : "?"}</b>
        {stock.line && mark && (
          <span className={`${css.m} ${stock.lineState === "fits" ? css.mOk : css.mClose}`}>
            <i aria-hidden>{mark}</i>{stock.line.label}{stock.why ? ` · ${stock.why}` : ""}
          </span>
        )}
        {!stock.stated && <span className={`${css.tag} ${css.tagWarn}`}>Quantity not stated</span>}
      </div>
      {stock.vehicles && <span className={css.sVehicles}>Same pack in {stock.vehicles}</span>}
      {stock.meta && <span className={css.muted}>{stock.meta}{stock.priceVaries ? " · prices vary a lot" : ""}</span>}
    </li>
  );
}

/**
 * One supplier: who and where, how many of each of the buyer's types they hold, their own stated prices, where the deal
 * stands and the action. Opened: one block per pack type, the buyer's types first, then other matching stock.
 */
function SupplierRow({ supplier, isOpen, onToggle, action }: { supplier: SupplierMatch; isOpen: boolean; onToggle: () => void; action: ReactNode }) {
  const where = standing(supplier.offer);
  const onLines = supplier.stock.filter((s) => s.line);
  const other = supplier.stock.filter((s) => !s.line);
  const prices = onLines.filter((s) => s.price).map((s) => `${s.line!.label} ${s.price}${s.priceVaries ? " (varies a lot)" : ""}`);
  const detailId = `supplier-${supplier.key.replace(/[^a-z0-9]/gi, "-")}`;
  const covered = supplier.cover.filter((c) => c.count > 0 || c.state !== "none").length;
  return (
    <div className={`${css.row} ${isOpen ? css.rowOpen : ""}`}>
      <div className={css.rowLine}>
        <button type="button" className={css.rowmain} aria-expanded={isOpen} aria-controls={detailId} onClick={onToggle}>
          <div className={css.left}>
            <div className={css.nameLine}>
              <span className={css.chev} aria-hidden>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              <span className={css.name}>{supplier.name}</span>
              {supplier.countries.length > 0 && <span className={`${css.muted} ${css.country}`}>{supplier.countries.join(", ")}</span>}
              {supplier.sourceKinds.length > 0 && <span className={css.tag}>{supplier.sourceKinds.map((s) => s[0].toUpperCase() + s.slice(1)).join(" · ")}</span>}
            </div>
            {supplier.cover.length > 0 && (
              <ul className={css.cover} aria-label="Their stock on each pack type">
                {supplier.cover.map((c) => (
                  <li key={c.id} className={`${css.m} ${COVER_CLS[c.state]}`}>
                    {c.label} {c.state === "none" ? "–" : <>× {c.count} <i aria-hidden>{c.state === "fits" ? "✓" : "≈"}</i></>}
                  </li>
                ))}
              </ul>
            )}
            <div className={css.holds}>
              {supplier.cover.length
                ? <><b>{supplier.onLines}</b> {supplier.onLines === 1 ? "pack" : "packs"} on {covered} of {supplier.cover.length} pack types{supplier.other ? <> · <b>{supplier.other}</b> other matching</> : null}</>
                : <><b>{supplier.other}</b> matching {supplier.other === 1 ? "pack" : "packs"} in {supplier.stock.length} {supplier.stock.length === 1 ? "type" : "types"}</>}
            </div>
            <div className={`${css.muted} ${css.source}`}>{prices.length ? `Their prices: ${prices.join(" · ")}` : supplier.cover.length ? "No prices stated on these types" : null}</div>
          </div>
        </button>
        <div className={css.side}>
          <div className={css.status}>
            <span><span className={`${css.dot} ${where.due ? css.dotDue : ""}`} aria-hidden /><b>{where.text}</b></span>
            {where.due && <span>No reply · chase due</span>}
          </div>
          <div className={css.actions}>{action}</div>
        </div>
      </div>
      {isOpen && (
        <div id={detailId} className={css.gDetail}>
          {onLines.length > 0 && (
            <div className={css.sBlock}>
              <div className={css.blockTitle}>On the buyer&apos;s pack types</div>
              <ul className={css.sStocks}>{onLines.map((s) => <StockBlock key={s.rowKey} stock={s} />)}</ul>
            </div>
          )}
          {other.length > 0 && (
            <div className={css.sBlock}>
              <div className={css.blockTitle}>{supplier.cover.length ? "Other matching stock" : "Matching stock"} <span className={css.muted}>· {supplier.cover.length ? "matches the request, not one of its pack types" : "by pack type"}</span></div>
              <ul className={css.sStocks}>{other.map((s) => <StockBlock key={s.rowKey} stock={s} />)}</ul>
            </div>
          )}
          <div className={`${css.muted} ${css.who}`} style={{ flexBasis: "100%" }}>Each unit is on Per battery matches.</div>
        </div>
      )}
    </div>
  );
}

/** Group matches: one row per supplier, the ones that cover most of the need first; suppliers with only other stock folded. */
export function GroupMatches({ suppliers, adding, onAdd, onOpenOffers }: {
  suppliers: SupplierMatch[]; adding: string | null; onAdd: (supplier: SupplierMatch) => void; onOpenOffers?: () => void;
}) {
  const [open, setOpen] = useState<string | null>(suppliers[0]?.key ?? null);
  const [showOther, setShowOther] = useState(false);
  const main = suppliers.filter((s) => !s.otherOnly);
  const otherOnly = suppliers.filter((s) => s.otherOnly);
  // What an offer for this supplier holds: their stock on the buyer's types, or all of it when they have none on them.
  const packs = (s: SupplierMatch) => (s.cover.length && !s.otherOnly ? s.onLines : s.other);
  const action = (s: SupplierMatch) => s.offer ? (
    <button type="button" className={css.btn} onClick={onOpenOffers} disabled={!onOpenOffers}>{s.offer.chaseDue ? "Chase" : "Open in Offers"}</button>
  ) : (
    <button type="button" className={`${css.btn} ${css.btnPri}`} disabled={adding === s.key} onClick={() => onAdd(s)}>
      {adding === s.key ? "Adding…" : `Add ${packs(s)} ${packs(s) === 1 ? "pack" : "packs"} to offers`}
    </button>
  );
  const row = (s: SupplierMatch) => (
    <SupplierRow key={s.key} supplier={s} isOpen={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} action={action(s)} />
  );
  return (
    <section className={css.card} aria-label="Group matches" style={{ overflow: "hidden" }}>
      <div className={css.sec}>
        <span className={css.secTitle}>Group matches <span className={css.muted}>· one row per supplier, all their matching stock</span></span>
        <span className={`${css.muted} ${css.legend}`}>Most of the need covered first, on confirmed stock</span>
      </div>
      {!suppliers.length && <p className={css.empty}>Nothing fits yet.</p>}
      {main.map(row)}
      {otherOnly.length > 0 && (
        <div className={css.otherOnly}>
          <span className={css.muted}>
            {otherOnly.length} more {otherOnly.length === 1 ? "supplier has" : "suppliers have"} only other matching stock: {otherOnly.map((s) => s.name).join(", ")}.
          </span>
          <button type="button" className={css.linkbtn} aria-expanded={showOther} onClick={() => setShowOther(!showOther)}>{showOther ? "Hide them" : "Show them"}</button>
        </div>
      )}
      {showOther && otherOnly.map(row)}
    </section>
  );
}

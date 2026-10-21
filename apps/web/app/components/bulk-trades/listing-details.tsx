"use client";

import { VISIBILITY_LABEL, shortDate } from "@/lib/bulk-trade-details";
import { readiness, stillNeeded, visibleGroups, type Claim, type Fact } from "@/lib/listing-facts";
import type { BuyerPack } from "@/lib/buyer-context";
import { Sh } from "./bt-shimmer";
import css from "./listing-details.module.css";

const claimText = (claim: Claim) => [claim.source, claim.date && shortDate(claim.date)].filter(Boolean).join(" · ");

function Source({ claim }: { claim: Claim }) {
  const text = claimText(claim);
  if (!text) return null;
  return claim.url ? <a href={claim.url} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>;
}

function Cell({ fact, onEdit, onResolve, loading = false }: { fact: Fact; loading?: boolean; onEdit?: (fact: Fact) => void; onResolve?: (fact: Fact, choice: number) => void }) {
  const conflict = fact.status === "conflict" && fact.claims.length > 1;
  const gap = !fact.value && !conflict;
  const wide = conflict || (fact.value?.length ?? 0) > 44;
  const meta = (fact.source || fact.status === "unverified" || fact.visibility) && !conflict && (
    <span className={css.meta}>
      {fact.status === "unverified" && <span className={css.flag}>Unverified</span>}
      {fact.source && <Source claim={fact.source} />}
      {fact.visibility && fact.value && <span>Buyers see: {VISIBILITY_LABEL[fact.visibility]}</span>}
    </span>
  );
  const body = (
    <>
      <span className={css.key}>{fact.label}</span>
      {loading ? <span className={css.value}><Sh on chars={14} /></span> : conflict ? (
        <span className={css.claims}>
          <span className={css.meta}><span className={css.flag} data-status="conflict">Conflict</span></span>
          {fact.claims.map((claim, index) => (
            <span key={index} className={css.claim}>
              <span className={css.value}>{claim.value}</span>
              <span className={css.meta}><Source claim={claim} /></span>
              {onResolve && (
                <button type="button" className={css.use} aria-label={`${index === 0 ? "Keep" : "Use"} ${claim.value}`}
                  onClick={() => onResolve(fact, index === 0 ? -1 : index - 1)}>{index === 0 ? "Keep this" : "Use this"}</button>
              )}
            </span>
          ))}
        </span>
      ) : gap ? <span className={css.gap} data-critical={fact.critical}>{onEdit ? "Missing" : "Not stated"}</span> : <span className={css.value}>{fact.value}</span>}
      {!loading && meta}
    </>
  );
  const props = { className: css.cell, "data-wide": wide };
  return onEdit && !conflict
    ? <button type="button" aria-label={`Edit ${fact.label}`} onClick={() => onEdit(fact)} {...props}>{body}</button>
    : <div {...props}>{body}</div>;
}

/** Several pack types asked for, one row each: pack (linked to its listing), chemistry, size, where it sits and when the buyer named it. */
export function PackTable({ packs }: { packs: BuyerPack[] }) {
  if (!packs.length) return null;
  const quantities = packs.some((pack) => pack.quantity && pack.quantity !== 1);
  const supply = packs.some((pack) => pack.supply_price != null);
  const suggested = packs.some((pack) => pack.suggested_price != null);
  const money = (value: number | undefined) => value == null ? "–" : `£${value.toLocaleString("en-GB")}`;
  return (
    <div className={css.packsScroll}>
      <table className={css.packs} aria-label="Packs asked for">
        <thead><tr><th>Pack</th>{quantities && <th>Qty</th>}<th>Chemistry</th><th>Capacity</th><th>Collection</th>{supply && <th>Supply price</th>}{suggested && <th>Suggested price</th>}<th>Named</th></tr></thead>
        <tbody>
          {packs.map((pack, i) => (
            <tr key={`${pack.title}-${i}`}>
              <td>
                {pack.url ? <a href={pack.url} target="_blank" rel="noreferrer">{pack.title}</a> : pack.title}
                {pack.status === "possible" && <span data-tentative>to confirm</span>}
              </td>
              {quantities && <td data-num="true">{pack.quantity ?? 1}</td>}
              <td>{pack.chemistry ?? "–"}</td>
              <td data-num="true">{pack.kwh ? `${pack.kwh} kWh` : "–"}</td>
              <td>{pack.location ?? "–"}</td>
              {supply && <td data-num="true">{money(pack.supply_price)}</td>}
              {suggested && <td data-num="true">{money(pack.suggested_price)}</td>}
              <td data-num="true">{pack.seen_on ? shortDate(pack.seen_on) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Details of any bulk listing: facts in a plain grid by section, readiness per step, and what is still missing.
 * Trade facts are editable (onEdit) and conflicts can be settled (onResolve); a demand's are read only.
 * Renders nothing when the listing has no recorded facts.
 */
export function ListingDetails({ facts, packs = [], onEdit, onResolve, loading = false }: {
  facts: Fact[];
  /** Pack types asked for; when present they are shown as a table under Product. */
  packs?: BuyerPack[];
  /** All values, or only specific async fact keys. */
  loading?: boolean | string[];
  onEdit?: (fact: Fact) => void;
  onResolve?: (fact: Fact, choice: number) => void;
}) {
  const steps = readiness(facts);
  const needed = stillNeeded(facts);
  const loadingFact = (key: string) => Array.isArray(loading) ? loading.includes(key) : loading;
  const sections = visibleGroups(facts.map((fact) => loadingFact(fact.key) ? { ...fact, critical: true } : fact));
  if (!facts.some((fact) => fact.value || fact.status === "conflict" || loadingFact(fact.key)) && !needed.length && !packs.length) return null;
  return (
    <div className={css.root} data-listing-details>
      {steps.length > 0 && (
        <div className={css.ready} aria-label="Readiness">
          {steps.map((step) => (
            <span key={step.step} className={css.step} data-done={step.have === step.total}>{step.step} <span>{step.have}/{step.total}</span></span>
          ))}
        </div>
      )}
      {sections.map((section) => (
        <section key={section.group} className={css.section}>
          <h3 className={css.label}>{section.group}</h3>
          <div className={css.grid}>
            {section.facts.map((fact) => <Cell key={fact.key} fact={fact} loading={loadingFact(fact.key)} onEdit={onEdit} onResolve={onResolve} />)}
          </div>
          {section.group === "Product" && <PackTable packs={packs} />}
        </section>
      ))}
      {needed.length > 0 && (
        <section className={css.needed} aria-label="Still needed">
          <h3 className={css.label}>Still needed</h3>
          {needed.map((entry) => (
            <div key={entry.step} className={css.neededRow}>
              <span>{entry.step}</span>
              {entry.facts.map((fact) => onEdit
                ? <button key={fact.key} type="button" className={css.chip} aria-label={`Add ${fact.label}`} onClick={() => onEdit(fact)}>{fact.label}</button>
                : <span key={fact.key} className={css.chip}>{fact.label}</span>)}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

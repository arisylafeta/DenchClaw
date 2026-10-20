"use client";

import { VISIBILITY_LABEL, shortDate } from "@/lib/bulk-trade-details";
import { readiness, stillNeeded, visibleGroups, type Claim, type Fact } from "@/lib/listing-facts";
import css from "./listing-details.module.css";

const claimText = (claim: Claim) => [claim.source, claim.date && shortDate(claim.date)].filter(Boolean).join(" · ");

function Source({ claim }: { claim: Claim }) {
  const text = claimText(claim);
  if (!text) return null;
  return claim.url ? <a href={claim.url} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>;
}

function Tile({ fact, onEdit, onResolve }: { fact: Fact; onEdit?: (fact: Fact) => void; onResolve?: (fact: Fact, choice: number) => void }) {
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
      {conflict ? (
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
      ) : gap ? <span className={css.ask}>{onEdit ? "Missing" : "Missing, ask the buyer"}</span> : <span className={css.value}>{fact.value}</span>}
      {meta}
    </>
  );
  const props = { className: css.tile, "data-status": fact.status, "data-gap": gap, "data-wide": wide };
  return onEdit && !conflict
    ? <button type="button" aria-label={`Edit ${fact.label}`} onClick={() => onEdit(fact)} {...props}>{body}</button>
    : <div {...props}>{body}</div>;
}

/**
 * The Details of any bulk listing: facts as coloured tiles by section, readiness per step, and what is still missing.
 * Trade facts are editable (onEdit) and conflicts can be settled (onResolve); a demand's are read only.
 * Renders nothing when the listing has no recorded facts.
 */
export function ListingDetails({ facts, onEdit, onResolve }: {
  facts: Fact[];
  onEdit?: (fact: Fact) => void;
  onResolve?: (fact: Fact, choice: number) => void;
}) {
  const steps = readiness(facts);
  const needed = stillNeeded(facts);
  const sections = visibleGroups(facts);
  if (!facts.some((fact) => fact.value || fact.status === "conflict") && !needed.length) return null;
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
        <section key={section.group} className={css.section} data-group={section.group}>
          <h3 className={css.label}>{section.group}</h3>
          <div className={css.grid}>
            {section.facts.map((fact) => <Tile key={fact.key} fact={fact} onEdit={onEdit} onResolve={onResolve} />)}
          </div>
        </section>
      ))}
      {needed.length > 0 && (
        <section className={css.needed} aria-label="Still needed">
          <h3 className={css.label} style={{ ["--tone" as string]: "var(--bt-amber)" }}>Still needed</h3>
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

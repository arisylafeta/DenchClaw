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

function Row({ fact, onEdit, onResolve }: { fact: Fact; onEdit?: (fact: Fact) => void; onResolve?: (fact: Fact, choice: number) => void }) {
  const conflict = fact.status === "conflict" && fact.claims.length > 1;
  const value = fact.value;
  return (
    <>
      <dt data-status={fact.status}>{fact.label}</dt>
      <dd data-status={fact.status}>
        {conflict ? (
          <span className={css.claims}>
            {fact.claims.map((claim, index) => (
              <span key={index} className={css.claim}>
                <span>{claim.value}</span>
                <span className={css.meta}><Source claim={claim} /></span>
                {onResolve && <button type="button" className={css.use} aria-label={`${index === 0 ? "Keep" : "Use"} ${claim.value}`}
                  onClick={() => onResolve(fact, index === 0 ? -1 : index - 1)}>
                  {index === 0 ? "Keep this" : "Use this"}
                </button>}
              </span>
            ))}
          </span>
        ) : onEdit ? (
          <button type="button" className={css.edit} aria-label={`Edit ${fact.label}`} onClick={() => onEdit(fact)}>
            {value ?? <span className={css.ask}>Missing</span>}
          </button>
        ) : value ?? <span className={css.ask}>Missing, ask the buyer</span>}
        {(fact.source || fact.status === "unverified" || fact.status === "conflict" || fact.visibility) && (
          <span className={css.meta}>
            {fact.status === "conflict" && <span className={css.flag} data-status="conflict">Conflict</span>}
            {fact.status === "unverified" && <span className={css.flag}>Unverified</span>}
            {!conflict && fact.source && <Source claim={fact.source} />}
            {fact.visibility && fact.value && <span>Buyers see: {VISIBILITY_LABEL[fact.visibility]}</span>}
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * The Details of any bulk listing: how ready it is, its facts by section, and what is still missing.
 * Trade facts are editable (onEdit) and conflicts can be settled (onResolve); a demand's are read only.
 */
export function ListingDetails({ facts, onEdit, onResolve }: {
  facts: Fact[];
  onEdit?: (fact: Fact) => void;
  onResolve?: (fact: Fact, choice: number) => void;
}) {
  const steps = readiness(facts);
  const needed = stillNeeded(facts);
  return (
    <div className={css.root} data-listing-details>
      {steps.length > 0 && (
        <div className={css.ready} aria-label="Readiness">
          {steps.map((step) => (
            <span key={step.step} className={css.step} data-done={step.have === step.total}>{step.step} <span>{step.have}/{step.total}</span></span>
          ))}
        </div>
      )}
      {visibleGroups(facts).map((section) => (
        <section key={section.group} className={css.section}>
          <h3 className={css.label}>{section.group}</h3>
          <dl className={css.facts}>
            {section.facts.map((fact) => <Row key={fact.key} fact={fact} onEdit={onEdit} onResolve={onResolve} />)}
          </dl>
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

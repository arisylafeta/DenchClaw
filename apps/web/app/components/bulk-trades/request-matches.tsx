"use client";

// The request (demand) Matches tab, laid out as the approved mockup (Matches v4, direction A "Ledger"): a summary card
// with the request's requirements as chips, then one card of ranked rows. Each row shows who, what they hold and from
// where, one fit mark per requirement, where this deal stands and the actions; a click opens the source, "How it fits"
// and "This deal with …". Slices 2–4 add checkboxes, grouping, near matches and the selection bar: each has a marked
// seam below. The supply tab does not use this file.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FitMark, FitState, MatchOffer, MatchRow, MatchTag, MatchesResult } from "@/lib/matches-types";
import type { OfferStage } from "@/lib/crm-postgres/bulk-offers";
import css from "./request-matches.module.css";

export const STAGES: [OfferStage, string][] = [
  ["candidate", "Candidate"], ["offered", "Offered"], ["negotiating", "Negotiating"],
  ["contract_out", "Contract out"], ["signed", "Signed"], ["invoiced", "Invoice out"], ["paid", "Paid"], ["complete", "Complete"],
  ["declined", "Declined"], ["lost", "Lost"],
];
export const STAGE_LABEL = Object.fromEntries(STAGES) as Record<OfferStage, string>;

/** "8 Nov", or "8 Nov 2025" once the date is not this year. */
export const offerDate = (iso: string | null) => {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
};

/** The four marks, as in the mock: glyph and word, never colour alone. */
const MARK: Record<FitState, { glyph: string; word: string; cls: string }> = {
  fits: { glyph: "✓", word: "fits", cls: css.mOk },
  close: { glyph: "≈", word: "close", cls: css.mClose },
  unstated: { glyph: "?", word: "not stated", cls: css.mUnk },
  misses: { glyph: "✗", word: "misses", cls: css.mMiss },
};

const TAG_CLASS: Partial<Record<MatchTag, string>> = { marketplace: css.tagMk, lead: css.tagLead };
const tagLabel = (tag: MatchTag) => tag[0].toUpperCase() + tag.slice(1);

/** One mark in the row: glyph and label, with the state word for screen readers and on hover. */
function Mark({ mark }: { mark: FitMark }) {
  const look = MARK[mark.state];
  return (
    <li className={`${css.m} ${look.cls}`} title={`${mark.label}: ${look.word}`}>
      <i aria-hidden>{look.glyph}</i>
      <span className="sr-only">{look.word}:</span>
      {mark.label}
    </li>
  );
}

/** "Where this deal stands", from the offer the row already became. */
function standing(offer: MatchOffer | null): { stage: string; note: string | null; due: boolean } {
  if (!offer) {
    return { stage: "Not contacted", note: null, due: false };
  }
  const stage = STAGE_LABEL[offer.stage as OfferStage] ?? offer.stage;
  return { stage: `In offers · ${stage} ${offerDate(offer.date)}`.trim(), note: offer.chaseDue ? "No reply · chase due" : null, due: !!offer.chaseDue };
}

/** The short name for "This deal with …": the first word of the company, without a bracketed aside. */
const shortName = (name: string) => name.replace(/\s*\(.*\)\s*/g, " ").trim().split(/\s+/)[0] || name;

type Props = {
  result: MatchesResult;
  rows: MatchRow[];
  hidden: number;
  onShowAll: () => void;
  criteriaOpen: boolean;
  onToggleCriteria: () => void;
  adding: string | null;
  onAdd: (row: MatchRow) => void;
  asking: string | null;
  onAskNotAFit: (row: MatchRow) => void;
  notAFitForm: (row: MatchRow) => ReactNode;
  error: ReactNode;
  onOpenOffers?: () => void;
};

export function RequestMatches({
  result, rows, hidden, onShowAll, criteriaOpen, onToggleCriteria, adding, onAdd, asking, onAskNotAFit, notAFitForm, error, onOpenOffers,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const coverage = result.coverage;
  const outreach = result.summary?.outreach ?? null;
  const chips = result.summary?.chips ?? [{ label: result.lotKey.line, strong: true }];
  const count = result.rows.length;
  const share = coverage ? Math.min(100, Math.round((coverage.stated / Math.max(1, coverage.need)) * 100)) : 0;

  const action = (row: MatchRow, primary: boolean) => row.offer ? (
    <button type="button" className={css.btn} onClick={onOpenOffers} disabled={!onOpenOffers}>
      {row.offer.chaseDue ? "Chase" : "Open in Offers"}
    </button>
  ) : (
    <button type="button" className={`${css.btn} ${primary ? css.btnPri : ""}`} disabled={adding === row.key} onClick={() => onAdd(row)}>
      {adding === row.key ? "Adding…" : "Add to offers"}
    </button>
  );
  const notAFit = (row: MatchRow) => (
    <button type="button" className={css.btn} aria-expanded={asking === row.key} onClick={() => onAskNotAFit(row)}>Not a fit</button>
  );

  return (
    <div className={css.wrap}>
      <section className={`${css.card} ${css.summary}`} aria-label="What we matched on">
        <div className={css.matchedOn}>
          <span className={css.matchedOnLabel}>Matched on</span>
          {chips.map((chip) => (
            <span key={chip.label} className={css.chip} title={chip.label}>{chip.strong ? <b>{chip.label}</b> : chip.label}</span>
          ))}
          {result.lotKey.full.length > 0 && (
            <button type="button" className={`${css.btn} ${css.btnGhost} ${css.criteriaToggle}`} aria-expanded={criteriaOpen}
              aria-controls="request-matches-criteria" onClick={onToggleCriteria}>
              Criteria {criteriaOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            </button>
          )}
        </div>
        {criteriaOpen && (
          <ul id="request-matches-criteria" className={css.criteria}>
            {result.lotKey.full.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {count > 0 && (
          <div className={css.stats}>
            <span><b>{count}</b> {count === 1 ? "source matches" : "sources match"}</span>
            {coverage && (
              <span className={css.stock}>
                Stated stock <b>{coverage.stated.toLocaleString("en-GB")}</b>
                {coverage.needMax
                  ? <> · need {coverage.need.toLocaleString("en-GB")}–{coverage.needMax.toLocaleString("en-GB")}</>
                  : <> of {coverage.need.toLocaleString("en-GB")}</>}
                <span className={css.bar} role="img" aria-label={`${share}% of the need stated`}><span style={{ width: `${share}%` }} /></span>
                {coverage.unstated > 0 && (
                  <span className={css.muted}>{coverage.unstated} {coverage.unstated === 1 ? "source hasn't said" : "sources haven't said"}</span>
                )}
              </span>
            )}
            {outreach && (
              <span>
                <b>{outreach.asked}</b> asked · <b>{outreach.replied}</b> replied
                {outreach.chaseDue > 0 && <> · <span className={css.due}>{outreach.chaseDue} chase due</span></>}
              </span>
            )}
          </div>
        )}
      </section>

      {error}

      <section className={css.card} aria-label="Matches" style={{ overflow: "hidden" }}>
        <div className={css.sec}>
          <span className={css.secTitle}>Matches <span className={css.muted}>· ranked by fit, then stated quantity</span></span>
          <span className={`${css.muted} ${css.legend}`} aria-label="Fit marks">
            {(Object.keys(MARK) as FitState[]).map((state) => (
              <span key={state} className={`${css.m} ${MARK[state].cls}`}><i aria-hidden>{MARK[state].glyph}</i> {MARK[state].word}</span>
            ))}
          </span>
        </div>
        {!count && <p className={css.empty}>{result.blocked ?? "Nothing fits yet. Add a dossier or a listing field to widen the match."}</p>}
        {rows.map((row) => {
          const isOpen = open === row.key;
          const where = standing(row.offer);
          const marks = row.fit ?? [];
          const detailId = `match-detail-${row.rank}`;
          return (
            <div key={row.key} className={`${css.row} ${isOpen ? css.rowOpen : ""}`}>
              <div className={css.rowLine}>
                {/* Slice 4 seam: the pick checkbox goes here, before the row button. */}
                <button type="button" className={css.rowmain} aria-expanded={isOpen} aria-controls={detailId}
                  onClick={() => setOpen(isOpen ? null : row.key)}>
                  <div className={css.left}>
                    <div className={css.nameLine}>
                      <span className={css.name}>{row.name}</span>
                      {row.country && <span className={`${css.muted} ${css.country}`}>{row.country}</span>}
                      {row.tags.map((tag) => <span key={tag} className={`${css.tag} ${TAG_CLASS[tag] ?? ""}`}>{tagLabel(tag)}</span>)}
                    </div>
                    <div className={css.holds}>
                      <span>{row.holds ?? row.reason}</span>
                      {row.price && !marks.some((mark) => mark.key === "price") && <> · <span>{row.price}</span></>}
                    </div>
                    {(row.source ?? row.detail) && <div className={`${css.muted} ${css.source}`}>{row.source ?? row.detail}</div>}
                  </div>
                  <ul className={css.marks} aria-label="How it fits">
                    {marks.map((mark) => <Mark key={`${mark.key}:${mark.label}`} mark={mark} />)}
                  </ul>
                  <div className={css.status}>
                    <span><span className={`${css.dot} ${where.due ? css.dotDue : ""}`} aria-hidden /><b>{where.stage}</b></span>
                    {where.note && <span>{where.note}</span>}
                  </div>
                </button>
                <div className={css.actions}>
                  {action(row, true)}
                  {notAFit(row)}
                </div>
              </div>
              {isOpen && (
                <div id={detailId} className={css.detail}>
                  <div className={`${css.block} ${css.blockSource}`}>
                    <div className={css.blockTitle}>Where this comes from</div>
                    {row.quote && <div className={css.quote}>“{row.quote}”</div>}
                    <div className={`${css.muted} ${css.who}`}>
                      {[row.name, row.source].filter(Boolean).join(", ")}
                      {row.link && <> · <a href={row.link.href} target={row.link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{row.link.label}</a></>}
                    </div>
                  </div>
                  <div className={`${css.block} ${css.blockFit}`}>
                    <div className={css.blockTitle}>How it fits</div>
                    <table className={css.ft}>
                      <thead><tr><th>Requirement</th><th>Buyer asked</th><th>They have</th><th><span className="sr-only">Fit</span></th></tr></thead>
                      <tbody>
                        {marks.map((mark) => (
                          <tr key={`${mark.key}:${mark.label}`}>
                            <td>{mark.name ?? mark.key}</td>
                            <td className={css.muted}>{mark.asked ?? ""}</td>
                            <td>{mark.have ?? mark.label}</td>
                            <td><span className={`${css.m} ${MARK[mark.state].cls}`}><i aria-hidden>{MARK[mark.state].glyph}</i>{MARK[mark.state].word}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={`${css.block} ${css.blockDeal}`}>
                    <div className={css.blockTitle}>This deal with {shortName(row.name)}</div>
                    <div className={css.dealNote}>
                      {row.offer ? `${where.stage}.${where.due ? " No reply after three working days." : ""}` : "Not contacted yet about this request."}
                    </div>
                    {(row.askFor ?? []).length > 0 && <div className={`${css.muted} ${css.who}`}>Ask for: {row.askFor!.join(", ")}.</div>}
                    <div className={css.dealActions}>
                      {action(row, true)}
                      {notAFit(row)}
                    </div>
                  </div>
                </div>
              )}
              {asking === row.key && <div className={css.notAFit}>{notAFitForm(row)}</div>}
            </div>
          );
        })}
      </section>
      {/* Slice 3 seam: the Near matches card goes here. Slice 4 seam: the sticky selection bar after it. */}

      {hidden > 0 && (
        <button type="button" className={`${css.btn} ${css.more}`} onClick={onShowAll}>Show {Math.min(10, hidden)} more of {hidden}</button>
      )}
    </div>
  );
}

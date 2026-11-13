"use client";

// The request (demand) Matches tab, laid out as the approved mockup (Matches v4, direction A "Ledger"): a summary card
// with the request's requirements as chips, then one card of ranked rows. Each row shows who, what they hold and from
// where, one fit mark per requirement, where this deal stands and the actions; a click opens the source, "How it fits"
// and "This deal with …". Slice 2 groups one seller's identical stock into one row (A-mixed / A-zoe boards): who, the
// pack, "Same pack in", and a units table when opened. Slices 3–4 add near matches, checkboxes and the selection bar:
// each has a marked seam below. The supply tab does not use this file.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FitMark, FitState, MatchOffer, MatchRow, MatchTag, MatchUnit, MatchesResult, SupplierMatch } from "@/lib/matches-types";
import type { OfferStage } from "@/lib/crm-postgres/bulk-offers";
import css from "./request-matches.module.css";
import { GroupMatches, NeedsCard } from "./group-matches";

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

/** The second status line for a row nobody has contacted, from where the line comes from (as the mock words it). */
const SOURCE_NOTE: Record<string, string> = {
  "marketplace listing": "Listed by the seller, ready to offer",
  email: "Mentioned in an email, never asked",
  "stock list": "From their stock list",
  catalogue: "From their catalogue",
  "eBay listing": "Listed for sale",
  "salvage listing": "Listed for sale",
};

/** "Where this deal stands", from the offer the row already became. */
function standing(offer: MatchOffer | null, sourceKind?: string | null): { stage: string; note: string | null; due: boolean } {
  if (!offer) {
    return { stage: "Not contacted", note: (sourceKind && SOURCE_NOTE[sourceKind]) || null, due: false };
  }
  const stage = STAGE_LABEL[offer.stage as OfferStage] ?? offer.stage;
  return { stage: `In offers · ${stage} ${offerDate(offer.date)}`.trim(), note: offer.chaseDue ? "No reply · chase due" : null, due: !!offer.chaseDue };
}

/**
 * The row's right-hand side: where the deal stands, then the actions. One element for every layout, so group rows and
 * single rows line up: after the marks on one line when the list is wide, a fixed right column (actions on top) at
 * Ari's width, and stacked with full-width actions on a phone (request-matches.module.css, container queries).
 */
function Side({ where, actions }: { where: ReturnType<typeof standing>; actions: ReactNode }) {
  return (
    <div className={css.side}>
      <div className={css.status}>
        <span><span className={`${css.dot} ${where.due ? css.dotDue : ""}`} aria-hidden /><b>{where.stage}</b></span>
        {where.note && <span>{where.note}</span>}
      </div>
      <div className={css.actions}>{actions}</div>
    </div>
  );
}

/** A unit's SoH or condition: the mark (glyph, word for screen readers, label) and where the figure comes from. */
function SohCell({ soh }: { soh: MatchUnit["soh"] }) {
  const look = MARK[soh.state];
  return (
    <>
      <span className={`${css.m} ${look.cls}`} title={`${soh.label}: ${look.word}`}>
        <i aria-hidden>{look.glyph}</i>
        <span className="sr-only">{look.word}:</span>
        {soh.label}
      </span>
      {soh.source && <> <span className={`${css.muted} ${css.sohSrc}`}>{soh.source}</span></>}
    </>
  );
}

/** Units shown before "Show all", as the mock. */
const FIRST_UNITS = 5;

type GroupRowProps = {
  row: MatchRow;
  isOpen: boolean;
  onToggle: () => void;
  /** Add to offers (or Open in Offers) and Not a fit, as on a single row. */
  actions: ReactNode;
  /** The Not a fit reasons, when asked for this row. */
  notAFit: ReactNode;
};

/**
 * One supplier and one pack type (A-mixed): who, the pack and how many, "Same pack in" with the vehicles, the price,
 * places and sources, one mark per requirement for the whole group, where the deal stands, and Add to offers. Opened
 * (A-zoe): why the packs count as the same, then the units, cheapest first: five, then all of them in a scrolling box
 * with a fixed header.
 */
function GroupRow({ row, isOpen, onToggle, actions, notAFit }: GroupRowProps) {
  const [all, setAll] = useState(false);
  const group = row.group!;
  const where = standing(row.offer, row.sourceKind);
  const marks = row.fit ?? [];
  const detailId = `match-detail-${row.rank}`;
  const noun = group.lots ? "lots" : "units";
  const visible = all ? group.units : group.units.slice(0, FIRST_UNITS);
  return (
    <div className={`${css.row} ${isOpen ? css.rowOpen : ""}`}>
      <div className={css.rowLine}>
        {/* Slice 4 seam: the group's pick checkbox goes here, before the row button. */}
        <button type="button" className={css.rowmain} aria-expanded={isOpen} aria-controls={detailId} onClick={onToggle}>
          <div className={`${css.left} ${css.gLeft}`}>
            <div className={css.gTitle}>
              <span className={css.name}>{row.name}</span>
              <span className={css.gPack}>{group.pack}</span>
              <span className={css.name}>× {group.count}{group.countWord ? ` ${group.countWord}` : ""}</span>
              {row.country && <span className={`${css.muted} ${css.country}`}>{row.country}</span>}
              {row.tags.map((tag) => <span key={tag} className={`${css.tag} ${TAG_CLASS[tag] ?? ""}`}>{tagLabel(tag)}</span>)}
              {group.unsure && <span className={`${css.tag} ${css.tagWarn}`}>Pack type not confirmed</span>}
            </div>
            {group.sameLabel && group.vehicles.length > 1 && (
              <div className={css.same}>
                <span className={css.muted}>{group.sameLabel}</span>
                {group.vehicles.map((vehicle) => <span key={vehicle.name} className={css.veh}>{vehicle.name} <b>{vehicle.n}</b></span>)}
              </div>
            )}
            <div className={`${css.muted} ${css.source}`}>{group.meta}</div>
          </div>
          <ul className={css.marks} aria-label="How it fits">
            {marks.map((mark) => <Mark key={`${mark.key}:${mark.label}`} mark={mark} />)}
          </ul>
        </button>
        <Side where={where} actions={actions} />
      </div>
      {isOpen && (
        <div id={detailId} className={css.gDetail}>
          {group.why && (
            <div className={css.gWhy}>
              <div className={css.blockTitle}>{group.why.title}</div>
              <div className={css.why}>{group.why.text}</div>
              {group.why.source && <div className={`${css.muted} ${css.who}`}>{group.why.source}</div>}
            </div>
          )}
          <div className={css.gUnits}>
          <div className={css.blockTitle}>
            {group.lots ? "Lots" : "Units"} <span className={css.muted}>· {group.units.length}, cheapest first</span>
          </div>
          {group.priceVaries && <div className={`${css.muted} ${css.who}`}>Prices vary a lot, check the units</div>}
          <div className={css.ubox} style={all ? { maxHeight: 360 } : undefined} role="region" aria-label={`${row.name}: ${noun}`} tabIndex={all ? 0 : undefined}>
            <table className={css.ut}>
              <thead>
                <tr>
                  {/* Slice 4 seam: the pick column (a 34px checkbox cell) goes first. */}
                  <th>{group.lots ? "Lot" : "Vehicle"}</th><th>Year</th><th>Stock ref</th><th>{group.lots ? "Condition" : "SoH / condition"}</th>
                  <th>Location</th><th className={css.num}>Price</th><th>Seen</th><th><span className="sr-only">Link</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((unit) => (
                  <tr key={unit.key}>
                    <td className={css.cellWrap}>{unit.vehicle}</td>
                    <td>{unit.year ?? ""}</td>
                    <td className={css.muted}>{unit.ref ?? "not stated"}</td>
                    <td><SohCell soh={unit.soh} /></td>
                    <td className={css.cellWrap}>{unit.location ?? ""}</td>
                    <td className={css.num}>{unit.price ?? ""}</td>
                    <td className={css.muted}>{unit.seen ?? ""}</td>
                    <td>{unit.link && <a href={unit.link.href} target="_blank" rel="noreferrer">{unit.link.label}</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {group.units.length > FIRST_UNITS && (
            <button type="button" className={css.linkbtn} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${group.units.length} ${noun} (${group.units.length - FIRST_UNITS} more)`}
            </button>
          )}
          </div>
        </div>
      )}
      {notAFit}
    </div>
  );
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
  onOpenDetails?: () => void;
  /** Group matches: one offer for a supplier, with all their stock on the buyer's pack types. */
  onAddSupplier: (supplier: SupplierMatch) => void;
};

export function RequestMatches({
  result, rows, hidden, onShowAll, criteriaOpen, onToggleCriteria, adding, onAdd, asking, onAskNotAFit, notAFitForm, error, onOpenOffers,
  onOpenDetails, onAddSupplier,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  // A request with several pack types opens on Group matches; one with fewer keeps the Per battery list alone.
  const lines = result.lines ?? [];
  const twoViews = lines.length >= 2 && !!result.suppliers;
  const [view, setView] = useState<"group" | "battery">("group");
  const coverage = result.coverage;
  const outreach = result.summary?.outreach ?? null;
  const chips = result.summary?.chips ?? [{ label: result.lotKey.line, strong: true }];
  const count = result.rows.length;
  const tally = result.summary?.count ?? null;
  const packTypes = result.summary?.packTypes ?? null;
  const grouped = !!result.summary?.grouped;
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
            {tally ? (
              <span>
                <b>{tally.suppliers}</b> {tally.suppliers === 1 ? "supplier" : "suppliers"} · <b>{tally.units.toLocaleString("en-GB")}</b>{" "}
                {tally.units === 1 ? `${tally.word.replace(/s$/, "")} matches` : `${tally.word} match`}
              </span>
            ) : (
              <span><b>{count}</b> {count === 1 ? "source matches" : "sources match"}</span>
            )}
            {packTypes && (
              <span>
                <b>{packTypes.types}</b> {packTypes.types === 1 ? "pack type" : "pack types"}
                {packTypes.unconfirmed > 0 && <>, <b>{packTypes.unconfirmed}</b> not confirmed</>}
              </span>
            )}
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

      {twoViews && <NeedsCard lines={lines} buyer={shortName(result.buyer ?? "the buyer")} onEdit={onOpenDetails} />}

      {twoViews && (
        <div className={css.tabs} role="tablist" aria-label="Matches view">
          <button type="button" role="tab" className={css.tab} aria-selected={view === "group"} onClick={() => setView("group")}>
            Group matches · {result.suppliers!.filter((s) => !s.otherOnly).length} suppliers
          </button>
          <button type="button" role="tab" className={css.tab} aria-selected={view === "battery"} onClick={() => setView("battery")}>
            Per battery matches · {result.rows.length}
          </button>
        </div>
      )}

      {error}

      {twoViews && view === "group" && <GroupMatches suppliers={result.suppliers!} adding={adding} onAdd={onAddSupplier} onOpenOffers={onOpenOffers} />}

      {(!twoViews || view === "battery") && <>
      <section className={css.card} aria-label="Matches" style={{ overflow: "hidden" }}>
        {grouped ? (
          <div className={css.sec}>
            <span className={css.secTitle}>Matches <span className={css.muted}>· one row per supplier and {tally?.word === "packs" || !tally ? "pack type" : "product"}</span></span>
            <span className={`${css.muted} ${css.legend}`}>Click a row for each unit and why the packs count as the same</span>
          </div>
        ) : (
          <div className={css.sec}>
            <span className={css.secTitle}>Matches <span className={css.muted}>· ranked by fit, then stated quantity</span></span>
            <span className={`${css.muted} ${css.legend}`} aria-label="Fit marks">
              {(Object.keys(MARK) as FitState[]).map((state) => (
                <span key={state} className={`${css.m} ${MARK[state].cls}`}><i aria-hidden>{MARK[state].glyph}</i> {MARK[state].word}</span>
              ))}
            </span>
          </div>
        )}
        {!count && <p className={css.empty}>{result.blocked ?? "Nothing fits yet. Add a dossier or a listing field to widen the match."}</p>}
        {rows.map((row) => {
          const isOpen = open === row.key;
          if (row.group) {
            return (
              <GroupRow key={row.key} row={row} isOpen={isOpen} onToggle={() => setOpen(isOpen ? null : row.key)}
                actions={<>{action(row, true)}{notAFit(row)}</>}
                notAFit={asking === row.key ? <div className={css.notAFit}>{notAFitForm(row)}</div> : null} />
            );
          }
          const where = standing(row.offer, row.sourceKind);
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
                </button>
                <Side where={where} actions={<>{action(row, true)}{notAFit(row)}</>} />
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
      </>}
    </div>
  );
}

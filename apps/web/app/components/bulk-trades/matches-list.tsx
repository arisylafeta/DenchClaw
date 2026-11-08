"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MatchOffer, MatchRow, MatchTag, MatchesResult } from "@/lib/matches-types";
import type { OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { Button, Chip, LinkButton, StatusDot, type ChipTone } from "@/components/ui/board";
import { ErrorText, request } from "./trade-ui";
import { rowFocus } from "./demand-page";
import { offerDate, RequestMatches, STAGE_LABEL } from "./request-matches";
import css from "./demand-panel.module.css";

/** The six reasons Alex uses, in the order he says them. Any other detail goes in the text field. */
const QUICK_REASONS = ["Price", "Wrong format", "Wrong chemistry", "Already sourced", "No longer buying", "Other"] as const;

const TAG_TONE: Record<MatchTag, ChipTone> = {
  "live ask": "accent",
  "our listing": "neutral",
  marketplace: "neutral",
  "unlisted stock": "neutral",
  lead: "blue",
};

type Props = {
  result: MatchesResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** POST target for Add to offers, already scoped to the listing. */
  offersEndpoint: string;
  onAdded: (row: MatchRow, offer: MatchOffer) => void;
  onNotAFit: (row: MatchRow, reason: string) => Promise<void>;
  onOpenOffers?: () => void;
};

/**
 * One ranked list, the same on a supply listing and on a request: rank, who, why it fits, what to check, the firm
 * price, and the two actions. Add to offers is the only button; Not a fit is a quiet action with quick reasons.
 */
export function MatchesList({ result, loading, error, onRetry, offersEndpoint, onAdded, onNotAFit, onOpenOffers }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(!!result?.lotKey.open);
    setShowAll(false);
  }, [result?.id, result?.lotKey?.open]);

  if (loading && !result) {
    return (
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        <span className="sr-only">Looking for matches</span>
        {[0, 1, 2].map((n) => (
          <div key={n} className="h-[58px] animate-pulse rounded-lg" style={{ background: "var(--color-surface-hover)" }} />
        ))}
      </div>
    );
  }
  if (error && !result) {
    return (
      <div className="flex flex-col gap-2">
        <ErrorText error={error} />
        <Button variant="secondary" size="small" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  if (!result || !Array.isArray(result.rows)) {
    return null;
  }

  const rows = showAll ? result.rows : result.rows.slice(0, 10);
  const hidden = result.rows.length - rows.length;

  async function add(row: MatchRow) {
    setAdding(row.key);
    setActionError(null);
    try {
      const body = {
        name: row.name,
        ...(row.contact ? { contact: row.contact } : {}),
        ...(row.personId ? { personId: row.personId } : {}),
        ...(row.companyId ? { companyId: row.companyId } : {}),
        stage: "candidate",
        // A matched row is a CRM company or person, so the server refuses a name-only add from here.
        source: "match",
        data: {
          match: { reason: row.reason, rank: row.rank, at: new Date().toISOString() },
          // A grouped row is still one offer per supplier: the cheapest unit stays the offer's stock line (No stock marks it),
          // and every unit's stock line is kept for the unit picking that comes next (slice 4).
          ...(row.stockId ? { stock_opportunity_id: row.stockId } : {}),
          ...(row.group?.stockIds.length ? { stock_opportunity_ids: row.group.stockIds } : {}),
        },
      };
      const saved = await request<{ offer: { id: string; stage: string | null; updated_at: string } }>(offersEndpoint, {
        method: "POST", body: JSON.stringify(body),
      });
      onAdded(row, { id: saved.offer.id, stage: saved.offer.stage ?? "candidate", date: saved.offer.updated_at.slice(0, 10) });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add the offer.");
    } finally {
      setAdding(null);
    }
  }

  async function saveNotAFit(row: MatchRow) {
    if (!quick) {
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await onNotAFit(row, note.trim() ? `${quick} — ${note.trim()}` : quick);
      setAsking(null);
      setQuick(null);
      setNote("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save the reason.");
    } finally {
      setSaving(false);
    }
  }

  // The Not a fit reasons, the same on both tabs.
  const notAFitForm = (row: MatchRow) => (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg border p-2.5"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      aria-label={`Why ${row.name} is not a fit`}
      onSubmit={(event) => { event.preventDefault(); void saveNotAFit(row); }}
    >
      <div className="flex flex-wrap gap-1.5">
        {QUICK_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            aria-pressed={quick === reason}
            onClick={() => setQuick(quick === reason ? null : reason)}
            className={`${rowFocus} rounded-md border px-2 py-1 text-[12px]`}
            style={{
              borderColor: quick === reason ? "var(--color-text)" : "var(--color-border)",
              background: quick === reason ? "var(--color-surface-hover)" : "transparent",
              fontWeight: quick === reason ? 600 : 400,
            }}
          >
            {reason}
          </button>
        ))}
      </div>
      <input
        aria-label="Anything else"
        maxLength={160}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Anything else (optional)"
        className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="xs" disabled={!quick || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <LinkButton variant="secondary" size="xs" onClick={() => { setAsking(null); setQuick(null); setNote(""); }}>
          Cancel
        </LinkButton>
      </div>
    </form>
  );

  const askNotAFit = (row: MatchRow) => { setAsking(asking === row.key ? null : row.key); setQuick(null); setNote(""); };

  // A request lays its matches out as the v4 mockup (summary card, ranked rows that open); a supply listing keeps v3's list.
  if (result.kind === "demand") {
    return (
      <RequestMatches
        result={result}
        rows={rows}
        hidden={hidden}
        onShowAll={() => setShowAll(true)}
        criteriaOpen={open}
        onToggleCriteria={() => setOpen(!open)}
        adding={adding}
        onAdd={(row) => void add(row)}
        asking={asking}
        onAskNotAFit={askNotAFit}
        notAFitForm={notAFitForm}
        error={<ErrorText error={actionError} />}
        onOpenOffers={onOpenOffers}
      />
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="matches-key"
          className={`${rowFocus} flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left`}
          onClick={() => setOpen(!open)}
        >
          <span className="text-[12px] shrink-0" style={{ color: "var(--color-text-muted)" }}>Matched on</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{result.lotKey.line}</span>
          {open ? <ChevronDown size={14} className="shrink-0" aria-hidden /> : <ChevronRight size={14} className="shrink-0" aria-hidden />}
        </button>
        {open && (
          <ul id="matches-key" className="mt-1 flex flex-col gap-1 border-l pl-3 text-[12px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
            {result.lotKey.full.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {result.rows.length > 0 && (
          <p className="mt-1 px-1 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            {result.rows.length} {result.rows.length === 1 ? "match" : "matches"} · {result.considered.toLocaleString("en-GB")} checked
          </p>
        )}
      </div>

      <ErrorText error={actionError} />

      {!result.rows.length && <p className={css.empty}>{result.blocked ?? "Nothing fits yet. Add a dossier or a listing field to widen the match."}</p>}

      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.key} className="border-t py-3 first:border-t-0 first:pt-0" style={{ borderColor: "var(--color-border)" }}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <span className="w-5 shrink-0 pt-0.5 text-right text-[12px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{row.rank}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[14px] font-semibold">{row.name}</span>
                    {row.tags.map((tag) => <Chip key={tag} tone={TAG_TONE[tag]}>{tag}</Chip>)}
                    {row.price && <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums">{row.price}</span>}
                  </div>
                  <p className="mt-0.5 text-[13px]">{row.reason}</p>
                  {row.detail && <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>{row.detail}</p>}
                  {row.checks.length > 0 && (
                    <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>Check: {row.checks.join(" · ")}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
                  {row.offer ? (
                    <button
                      type="button"
                      className={`${rowFocus} inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] font-medium underline-offset-2 hover:underline`}
                      style={{ color: "var(--color-accent)" }}
                      onClick={onOpenOffers}
                      disabled={!onOpenOffers}
                    >
                      <StatusDot tone={row.offer.stage === "declined" || row.offer.stage === "lost" ? "red" : "green"} />
                      In offers · {STAGE_LABEL[row.offer.stage as OfferStage] ?? row.offer.stage} {offerDate(row.offer.date)}
                    </button>
                  ) : (
                    <Button variant="secondary" size="small" disabled={adding === row.key} onClick={() => void add(row)}>
                      {adding === row.key ? "Adding…" : "Add to offers"}
                    </Button>
                  )}
                  <LinkButton
                    variant="secondary"
                    size="xs"
                    aria-expanded={asking === row.key}
                    onClick={() => { setAsking(asking === row.key ? null : row.key); setQuick(null); setNote(""); }}
                  >
                    Not a fit
                  </LinkButton>
                </div>
              </div>

              {asking === row.key && notAFitForm(row)}
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <LinkButton variant="secondary" size="small" onClick={() => setShowAll(true)}>
          Show {Math.min(10, hidden)} more of {hidden}
        </LinkButton>
      )}
    </div>
  );
}

/** Loads one listing's matches and owns the writes the list makes. */
export function MatchesTab({ kind, id, active, onOpenOffers }: { kind: "supply" | "demand"; id: string; active: boolean; onOpenOffers?: () => void }) {
  const base = kind === "supply"
    ? `/api/bulk-listings/${encodeURIComponent(id)}/matches/v2`
    : `/api/bulk-trades/demand/${encodeURIComponent(id)}/matches/v2`;
  const offersEndpoint = kind === "supply"
    ? `/api/bulk-listings/${encodeURIComponent(id)}/offers`
    : `/api/bulk-trades/demand/${encodeURIComponent(id)}/offers`;
  const [data, setData] = useState<MatchesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await request<MatchesResult>(base);
      if (!payload || !Array.isArray(payload.rows) || !payload.lotKey) {
        throw new Error("Could not load matches.");
      }
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load matches.");
    } finally {
      setLoading(false);
    }
  }, [base]);
  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, load]);
  if (!active) {
    return null;
  }
  return (
    <MatchesList
      result={data}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      offersEndpoint={offersEndpoint}
      onOpenOffers={onOpenOffers}
      onAdded={(row, offer) => setData((current) => current && {
        ...current,
        rows: current.rows.map((item) => (item.key === row.key ? { ...item, offer } : item)),
      })}
      onNotAFit={async (row, reason) => {
        await request(base, { method: "POST", body: JSON.stringify({ key: row.key, label: row.name, reason }) });
        setData((current) => current && { ...current, rows: current.rows.filter((item) => item.key !== row.key) });
      }}
    />
  );
}

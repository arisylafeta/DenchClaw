"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Search,
  Send,
  Phone,
  FileText,
  Package,
  Pencil,
  Trash2,
  Link2,
  Plus,
  ChevronDown,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Story } from "./story-entry";
import styles from "./bulk-detail.module.css";
import {
  CLOSED_REASON_LABEL,
  HISTORY_CATEGORIES,
  type ClosedReason,
  type Demand,
} from "@/lib/bulk-demand";
import { shortDate } from "@/lib/bulk-trade-details";
import type { DemandActivity as Activity } from "@/lib/crm-postgres/bulk-demand-activity";
import {
  ErrorText,
  FormField,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  request,
} from "./trade-ui";

const ACTIVITY_KINDS = [
  "note",
  "research",
  "outreach",
  "call",
  "quote",
  "supply",
] as const;
const ACTIVITY_ICONS = {
  note: MessageSquare,
  research: Search,
  outreach: Send,
  call: Phone,
  quote: FileText,
  supply: Package,
};
/** What a buyer can be asked for, and whether this row is missing it. */
function gapsFor(demand: Partial<Demand> & Pick<Demand, "id" | "status">) {
  const spec = demand.spec ?? {};
  return [
    { key: "price", label: "Price", missing: demand.max_price == null },
    { key: "quantity", label: "Quantity", missing: !demand.quantity?.trim() && demand.volume == null },
    { key: "timeline", label: "Timeline", missing: demand.kind === "request" && !demand.needed_by },
    { key: "spec", label: "Spec", missing: !spec.kwh_min && !spec.kwh_max && !spec.chemistries?.length && !demand.product_family },
    { key: "delivery", label: "Delivery", missing: !demand.location },
  ];
}
const GAP_QUESTION: Record<string, string> = {
  price: "what price you can pay (per kWh or per unit)",
  quantity: "how many units you need",
  timeline: "by when you need them",
  spec: "the exact pack or cell, capacity and chemistry",
  delivery: "where they should be delivered",
};
/** One plain question from the picked gaps: "Could you confirm what price you can pay and by when you need them?" */
export function questionFor(keys: string[]): string {
  const parts = keys.map((key) => GAP_QUESTION[key]).filter(Boolean);
  if (!parts.length) return "";
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Could you confirm ${joined}?`;
}

// Close reasons in the order a trader reaches for them; the tidy-up ones sit below a divider.
const CLOSE_MAIN: ClosedReason[] = ["bought_from_us", "bought_elsewhere", "no_longer_needed", "expired"];
const CLOSE_TIDY: ClosedReason[] = ["duplicate", "offer_reply", "not_demand", "moved_to_profile", "recycling", "supply", "other"];
const STATUS_LABEL = { open: "Demand", qualifying: "Qualifying", closed: "History" } as const;
const STATUS_DOT = { open: "var(--bt-green)", qualifying: "var(--bt-amber)", closed: "var(--bt-muted)" } as const;

/** One status control: shows where the row is and when we last heard, and holds every move in one menu. */
function StatusMenu({ demand, busy, onConfirm, onNeedsInfo, onAnswered, onAsked, onClose, onCategory }: {
  demand: Partial<Demand> & Pick<Demand, "id" | "status">; busy: boolean; onConfirm: () => void; onNeedsInfo: () => void; onAnswered: () => void; onAsked: () => void;
  onClose: (reason: ClosedReason) => void; onCategory: (reason: ClosedReason) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = (action: () => void) => () => { setOpen(false); action(); };
  const status = demand.status;
  const label = status === "closed" && demand.closed_reason ? `History · ${CLOSED_REASON_LABEL[demand.closed_reason]}` : STATUS_LABEL[status];
  const sub = status === "open" ? (demand.confirmed_on ? `Buyer confirmed ${shortDate(demand.confirmed_on)}` : "Not confirmed by the buyer")
    : status === "qualifying" ? (demand.qualify_asked_on ? `Question asked ${shortDate(demand.qualify_asked_on)}` : "Question not asked yet") : null;
  const item = (text: string, hint: string | null, action: () => void) => (
    <button type="button" role="menuitem" disabled={busy} className={styles.menuItem} onClick={pick(action)}>
      <span>{text}</span>{hint && <span className={styles.menuHint}>{hint}</span>}
    </button>
  );
  return (
    <div ref={box} className="relative flex flex-col items-end">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Status: ${label}`} disabled={busy}
        className={styles.statusButton} onClick={() => setOpen(!open)}>
        <span className={styles.statusDot} style={{ background: STATUS_DOT[status] }} aria-hidden />
        {label}
        <ChevronDown size={14} aria-hidden />
      </button>
      {sub && <span data-status-caption className="mt-1 text-[11px]" style={{ color: "var(--bt-muted)" }}>{sub}</span>}
      {open && (
        <div role="menu" aria-label="Change status" className={styles.menu}>
          {status === "open" && item("Buyer confirmed it today", "Keeps it fresh in the ranking", onConfirm)}
          {status === "open" && item("Needs info…", "Move to Qualifying with a question", onNeedsInfo)}
          {status === "qualifying" && item("Answered, back to Demand", "Fill the answer in with Edit first", onAnswered)}
          {status === "qualifying" && item(demand.qualify_asked_on ? "Asked again today" : "Mark question asked", null, onAsked)}
          {status === "qualifying" && item("Edit question…", null, onNeedsInfo)}
          {status === "closed" && item("Reopen", "Back to Demand, confirmed today", onConfirm)}
          {status === "closed" && (
            <>
              <div className={styles.menuLabel}>Change category</div>
              {HISTORY_CATEGORIES.filter((reason) => reason !== demand.closed_reason).map((reason) => (
                <span key={reason} className="contents">{item(CLOSED_REASON_LABEL[reason], null, () => onCategory(reason))}</span>
              ))}
            </>
          )}
          {status !== "closed" && (
            <>
              <div className={styles.menuLabel}>Close as</div>
              {CLOSE_MAIN.map((reason) => <span key={reason} className="contents">{item(CLOSED_REASON_LABEL[reason], null, () => onClose(reason))}</span>)}
              <div className={styles.menuDivider} />
              {CLOSE_TIDY.map((reason) => <span key={reason} className="contents">{item(CLOSED_REASON_LABEL[reason], null, () => onClose(reason))}</span>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DemandActions({
  demand,
  today,
  onClose,
  onChanged,
  onEdit,
  onOpenTrade,
  onOpenSupply,
  section,
  story = false,
  activityEndpoint,
}: {
  demand: Partial<Demand> & Pick<Demand, "id" | "status">;
  today: string;
  onClose: () => void;
  onChanged: () => void;
  onEdit: () => void;
  onOpenTrade: (lotId: string) => void;
  onOpenSupply?: (id: string) => void;
  section: string;
  /** Trades Preview: the activity list reads as a story (labelled, dated, evidence-linked). */
  story?: boolean;
  activityEndpoint?: string;
}) {
  const [activityLoading, setActivityLoading] = useState(true);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [kind, setKind] = useState<string>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [refKind, setRefKind] = useState("url");
  const [choices, setChoices] = useState<
    { id: string; label: string; kind: string }[]
  >([]);
  const [logging, setLogging] = useState(false);
  const gaps = gapsFor(demand);
  const [picked, setPicked] = useState<string[]>([]);
  const [qualifying, setQualifying] = useState(false);
  const [question, setQuestion] = useState(demand.qualify_question ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`;
  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const result = await request<{ activity: Activity[] }>(
        `${activityEndpoint ?? endpoint}/activity`,
      );
      setActivity(result.activity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load activity.");
    } finally {
      setActivityLoading(false);
    }
  }, [endpoint, activityEndpoint]);
  // The status buttons and the timeline render as two instances (beside the ask, and in the Activity tab).
  const showsActivity = section === "Activity";
  useEffect(() => {
    if (showsActivity) void loadActivity();
  }, [loadActivity, showsActivity]);
  useEffect(() => {
    if (refKind !== "lot" && refKind !== "supply") return;
    let cancelled = false;
    void request<{
      trades?: { id: string; title: string }[];
      supply?: { id: string; seller: string; offers: string }[];
    }>(refKind === "lot" ? "/api/bulk-trades" : "/api/bulk-trades/supply")
      .then((result) => {
        if (!cancelled)
          setChoices(
            refKind === "lot"
              ? (result.trades ?? []).map((item) => ({
                  id: item.id,
                  label: item.title,
                  kind: "lot",
                }))
              : (result.supply ?? []).map((item) => ({
                  id: item.id,
                  label: `${item.seller} · ${item.offers}`,
                  kind: "supply",
                })),
          );
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Could not load links.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [refKind]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadActivity();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const patch = (value: object) =>
    request(endpoint, { method: "PATCH", body: JSON.stringify(value) });
  const add = (value: object) =>
    request(`${activityEndpoint ?? endpoint}/activity`, {
      method: "POST",
      body: JSON.stringify(value),
    });
  return (
    <>
      {(!story || section === "Overview") && <div className={section === "Overview" ? "space-y-3" : "hidden"}>
        <div data-preview-toolbar={story || undefined} className="flex items-start justify-end gap-2">
          <StatusMenu
            demand={demand}
            busy={busy}
            onConfirm={() => run(() => patch({ action: "confirm" }))}
            onNeedsInfo={() => {
              setQuestion(demand.qualify_question || questionFor(gaps.filter((g) => g.missing).map((g) => g.key)));
              setPicked(demand.qualify_question ? [] : gaps.filter((g) => g.missing).map((g) => g.key));
              setQualifying(true);
            }}
            onAnswered={() =>
              run(async () => {
                // The answered question goes to the timeline, then the row is plain demand again.
                if (demand.qualify_question) await add({ kind: "status", title: `Answered: ${demand.qualify_question}` });
                await patch({ status: "open", qualify_question: null, qualify_asked_on: null });
              })
            }
            onAsked={() => run(() => patch({ qualify_asked_on: today }))}
            onClose={(why) => run(() => patch({ action: "close", reason: why }))}
            onCategory={(why) => run(() => patch({ action: "category", reason: why }))}
          />
          {!story && (
            <button aria-label="Edit demand" className={`${buttonClass} px-2.5`} style={buttonStyle} onClick={onEdit}>
              <Pencil size={14} />
            </button>
          )}
        </div>
        {qualifying && (
          <form
            className={styles.callout}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await patch({
                  status: "qualifying",
                  qualify_question: question,
                });
                setQualifying(false);
              });
            }}
          >
            <p className="mb-2 text-xs font-medium" style={{ color: "var(--bt-muted)" }}>What do we need from the buyer?</p>
            <div className="mb-3 flex flex-wrap gap-3">
              {gaps.map((gap) => (
                <label key={gap.key} className="inline-flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={picked.includes(gap.key)}
                    onChange={(event) => {
                      const next = event.target.checked ? [...picked, gap.key] : picked.filter((key) => key !== gap.key);
                      setPicked(next);
                      setQuestion(questionFor(next));
                    }}
                  />
                  {gap.label}
                </label>
              ))}
            </div>
            <FormField label="Question to ask">
              <textarea
                required
                rows={2}
                className="w-full"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </FormField>
            <button
              disabled={busy || !question.trim()}
              className={`${buttonClass} mt-3`}
              style={buttonStyle}
            >
              {demand.status === "qualifying" ? "Save question" : "Move to Qualifying"}
            </button>
            <button type="button" className={`${buttonClass} ml-2 mt-3`} style={buttonStyle} onClick={() => setQualifying(false)}>
              Cancel
            </button>
          </form>
        )}
      </div>}
      <ErrorText error={error} />
      {showsActivity && (<section aria-label={story ? "History" : "Activity"}>
        <h3 className={story ? "sr-only" : "mb-3 text-sm font-semibold"}>
          {story ? "History" : "Activity"}{" "}
          <span
            className="ml-1 font-normal"
            style={{ color: "var(--bt-muted)" }}
          >
            {story && activityLoading ? null : activity.length}
          </span>
        </h3>
        {!story && !logging && (
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setLogging(true)}>
            <Plus size={14} />
            Log activity
          </button>
        )}
        {!story && (
        <form
          style={logging ? undefined : { display: "none" }}
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await add({
                kind,
                title,
                body: body || undefined,
                ...(link ? { refKind, refId: link } : {}),
              });
              setTitle("");
              setBody("");
              setLink("");
              setLogging(false);
            });
          }}
        >
          <div role="group" aria-label="Activity kind" className={styles.kinds}>
            {ACTIVITY_KINDS.map((value) => {
              const Icon = ACTIVITY_ICONS[value];
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  className={styles.kind}
                  onClick={() => setKind(value)}
                >
                  <Icon size={14} />
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              );
            })}
          </div>
          <input
            required
            aria-label="Activity title"
            placeholder="What happened?"
            className="w-full"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <details>
            <summary
              className="cursor-pointer text-xs"
              style={{ color: "var(--bt-muted)" }}
            >
              Add details or a link
            </summary>
            <textarea
              aria-label="Activity body"
              placeholder="Details"
              rows={3}
              className="my-3 w-full resize-y"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="flex gap-2">
              <select
                aria-label="Link type"
                value={refKind}
                onChange={(event) => {
                  setRefKind(event.target.value);
                  setLink("");
                }}
              >
                <option value="url">URL</option>
                <option value="lot">Lot</option>
                <option value="supply">Supply</option>
                <option value="stock">Stock item</option>
              </select>
              <input
                aria-label="Activity link"
                type={refKind === "url" || refKind === "stock" ? "url" : "text"}
                role={
                  refKind === "lot" || refKind === "supply"
                    ? "combobox"
                    : undefined
                }
                aria-expanded={
                  refKind === "lot" || refKind === "supply" ? false : undefined
                }
                aria-controls={
                  refKind === "lot" || refKind === "supply"
                    ? `activity-links-${demand.id}`
                    : undefined
                }
                list={
                  refKind === "lot" || refKind === "supply"
                    ? `activity-links-${demand.id}`
                    : undefined
                }
                placeholder={
                  refKind === "url" || refKind === "stock"
                    ? "https://"
                    : "Choose an item"
                }
                className="min-w-0 flex-1"
                value={link}
                onChange={(event) => setLink(event.target.value)}
              />
              <datalist id={`activity-links-${demand.id}`}>
                {choices
                  .filter((item) => item.kind === refKind)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </datalist>
            </div>
          </details>
          <button
            disabled={busy || !title.trim()}
            className={`${darkButtonClass} self-end`}
            style={darkButtonStyle}
          >
            <Plus size={14} className="mr-1" />
            Add activity
          </button>
        </form>
        )}
        {!activity.length && !(story && activityLoading) && (
          <p
            className="py-5 text-center text-xs"
            style={{ color: "var(--bt-muted)" }}
          >
            No activity yet
          </p>
        )}
        {story ? (
          <Story loading={activityLoading} activity={activity} onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
        ) : (
        <ol className={styles.timeline}>
          {activity.map((entry) => {
            const Icon =
              ACTIVITY_ICONS[entry.kind as keyof typeof ACTIVITY_ICONS] ??
              MessageSquare;
            const linked =
              entry.ref_id &&
              (entry.ref_kind === "lot" ||
                entry.ref_kind === "supply" ||
                /^https?:\/\//i.test(entry.ref_id));
            return (
              <li key={entry.id} className={styles.entry}>
                <span className={styles.entryIcon}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-[13px] font-medium">
                      {entry.title}
                    </p>
                    <button
                      type="button"
                      className={styles.delete}
                      disabled={busy}
                      aria-label={`Delete ${entry.title}`}
                      onClick={() =>
                        run(() =>
                          request(`${activityEndpoint ?? endpoint}/activity/${entry.id}`, {
                            method: "DELETE",
                          }),
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <time
                    className="mt-1 block text-[11px]"
                    style={{ color: "var(--bt-muted)" }}
                    dateTime={entry.occurred_at}
                    title={shortDate(entry.occurred_at.slice(0, 10))}
                  >
                    {formatDistanceToNow(new Date(entry.occurred_at), {
                      addSuffix: true,
                    })}
                  </time>
                  {entry.body && (
                    <p
                      className="mt-2 whitespace-pre-wrap text-xs leading-relaxed"
                      style={{ color: "var(--bt-muted)" }}
                    >
                      {entry.body}
                    </p>
                  )}
                  {linked &&
                    (entry.ref_kind === "lot" || entry.ref_kind === "supply" ? (
                      <button
                        className={styles.chip}
                        onClick={() =>
                          entry.ref_kind === "lot"
                            ? onOpenTrade(entry.ref_id!)
                            : onOpenSupply?.(entry.ref_id!)
                        }
                      >
                        <Link2 size={11} />
                        View {entry.ref_kind}
                      </button>
                    ) : (
                      <a
                        className={styles.chip}
                        href={entry.ref_id!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Link2 size={11} />
                        Open link
                      </a>
                    ))}
                </div>
              </li>
            );
          })}
        </ol>
        )}
      </section>)}
    </>
  );
}

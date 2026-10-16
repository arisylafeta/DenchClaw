"use client";

import { useCallback, useEffect, useState } from "react";
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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import styles from "./bulk-detail.module.css";
import {
  CLOSED_REASONS,
  CLOSED_REASON_LABEL,
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
export function DemandActions({
  demand,
  today,
  onClose,
  onChanged,
  onEdit,
  onOpenTrade,
  onOpenSupply,
  section,
}: {
  demand: Demand;
  today: string;
  onClose: () => void;
  onChanged: () => void;
  onEdit: () => void;
  onOpenTrade: (lotId: string) => void;
  onOpenSupply?: (id: string) => void;
  section: string;
}) {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [kind, setKind] = useState<string>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [refKind, setRefKind] = useState("url");
  const [choices, setChoices] = useState<
    { id: string; label: string; kind: string }[]
  >([]);
  const [closing, setClosing] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const [question, setQuestion] = useState(demand.qualify_question ?? "");
  const [reason, setReason] = useState<ClosedReason>("no_longer_needed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`;
  const loadActivity = useCallback(async () => {
    try {
      const result = await request<{ activity: Activity[] }>(
        `${endpoint}/activity`,
      );
      setActivity(result.activity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load activity.");
    }
  }, [endpoint]);
  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);
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
    request(`${endpoint}/activity`, {
      method: "POST",
      body: JSON.stringify(value),
    });
  return (
    <>
      <div className={section === "Overview" ? "space-y-3" : "hidden"}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={busy}
            className={darkButtonClass}
            style={darkButtonStyle}
            onClick={() => run(() => patch({ action: "confirm" }))}
          >
            {demand.status === "closed" ? "Reopen" : "Still wanted"}
          </button>
          <button
            disabled={busy}
            className={buttonClass}
            style={buttonStyle}
            onClick={() => setQualifying(!qualifying)}
          >
            Qualify
          </button>
          {demand.status !== "closed" && (
            <button
              className={buttonClass}
              style={buttonStyle}
              onClick={() => setClosing(!closing)}
            >
              Close
            </button>
          )}
          <button
            aria-label="Edit demand"
            className={`${buttonClass} ml-auto px-2.5`}
            style={buttonStyle}
            onClick={onEdit}
          >
            <Pencil size={14} />
          </button>
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
            <FormField label="Qualification question">
              <input
                required
                className="w-full"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </FormField>
            <button
              disabled={busy}
              className={`${buttonClass} mt-3`}
              style={buttonStyle}
            >
              Save question
            </button>
          </form>
        )}
        {demand.status === "qualifying" && !qualifying && (
          <div className={styles.callout}>
            <p
              className="mb-2 text-xs font-medium"
              style={{ color: "var(--bt-muted)" }}
            >
              To qualify
            </p>
            <p className="text-sm leading-relaxed">
              {demand.qualify_question ?? "What do they need?"}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                disabled={busy}
                className={`${buttonClass} h-8 text-xs`}
                style={buttonStyle}
                onClick={() => run(() => patch({ qualify_asked_on: today }))}
              >
                <Send size={12} />
                Mark question sent
              </button>
              {demand.qualify_asked_on && (
                <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
                  Sent {shortDate(demand.qualify_asked_on)}
                </span>
              )}
            </div>
          </div>
        )}
        {closing && (
          <div className="flex gap-2">
            <select
              aria-label="Why"
              className="min-w-0 flex-1"
              value={reason}
              onChange={(event) =>
                setReason(event.target.value as ClosedReason)
              }
            >
              {CLOSED_REASONS.map((value) => (
                <option key={value} value={value}>
                  {CLOSED_REASON_LABEL[value]}
                </option>
              ))}
            </select>
            <button
              disabled={busy}
              className={buttonClass}
              style={buttonStyle}
              onClick={() =>
                run(async () => {
                  await patch({ action: "close", reason });
                  setClosing(false);
                })
              }
            >
              Close demand
            </button>
          </div>
        )}
      </div>
      <section aria-label="Activity" hidden={section !== "Activity"}>
        <h3 className="mb-3 text-sm font-semibold">
          Activity{" "}
          <span
            className="ml-1 font-normal"
            style={{ color: "var(--bt-muted)" }}
          >
            {activity.length}
          </span>
        </h3>
        <form
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
        <ErrorText error={error} />
        {!activity.length && (
          <p
            className="py-5 text-center text-xs"
            style={{ color: "var(--bt-muted)" }}
          >
            No activity yet
          </p>
        )}
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
                          request(`${endpoint}/activity/${entry.id}`, {
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
      </section>
    </>
  );
}

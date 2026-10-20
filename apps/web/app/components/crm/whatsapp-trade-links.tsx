"use client";
import { useEffect, useState } from "react";
import styles from "./inbox/mail.module.css";
type EvidenceLink = { lot_id: string; evidence_kind: string; evidence_id: string; title: string };
export function WhatsappTradeLinks({
  threadId,
  messageId,
}: {
  threadId: string;
  messageId?: string;
}) {
  const [links, setLinks] = useState<EvidenceLink[]>([]);
  const [open, setOpen] = useState(false);
  const [trades, setTrades] = useState<Array<{ id: string; title: string }>>([]);
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    fetch(`/api/whatsapp/trade-links?threadId=${encodeURIComponent(threadId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error("Could not load trade links");
        }
        setLinks((await r.json()).links);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
        }
      });
    return () => controller.abort();
  }, [threadId, revision, open]);
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/whatsapp/trade-links?search=${encodeURIComponent(search)}`, {
        signal: controller.signal,
      })
        .then(async (r) => {
          if (!r.ok) {
            throw new Error("Could not search trades");
          }
          setTrades((await r.json()).trades);
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setError(e.message);
          }
        });
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [search, open]);
  async function change(
    link: { lot_id: string; evidence_kind: string; evidence_id: string },
    remove: boolean,
  ) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/whatsapp/trade-links", {
        method: remove ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotId: link.lot_id,
          evidenceKind: link.evidence_kind,
          evidenceId: link.evidence_id,
        }),
      });
      if (!r.ok) {
        throw new Error((await r.json()).error || "Could not update trade link");
      }
      setRevision((v) => v + 1);
      setSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update trade link");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={messageId ? "mt-1 text-[12px] opacity-0 transition-opacity open:opacity-100 focus-within:opacity-100 group-hover:opacity-100" : "my-2 rounded-lg border px-3 py-2 text-[12px]"}
      style={{ color: "var(--color-text-muted)" }}
    >
      <summary className="cursor-pointer select-none list-none">{messageId ? "Link to trade" : "Explicit trade links"}</summary>
      <p className="my-2">
        Link only relevant evidence. Group membership alone is not a trade relationship.
      </p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {links
          .filter((l) => (messageId ? l.evidence_id === messageId : true))
          .map((l) => (
            <li
              className="my-2 flex items-center gap-2"
              key={`${l.lot_id}:${l.evidence_kind}:${l.evidence_id}`}
            >
              <span>
                {l.title} ·{" "}
                {l.evidence_kind === "whatsapp_live_message" ? "message" : "whole thread"}
              </span>
              <button
                className={styles.control}
                disabled={busy}
                onClick={() => void change(l, true)}
              >
                Unlink evidence
              </button>
            </li>
          ))}
      </ul>
      <label>
        Find a trade
        <input
          className={`${styles.control} ml-2`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <ul>
        {trades.map((t) => (
          <li key={t.id}>
            <button
              className="my-2 underline"
              disabled={busy}
              onClick={() =>
                void change(
                  {
                    lot_id: t.id,
                    evidence_kind: messageId ? "whatsapp_live_message" : "whatsapp_live_thread",
                    evidence_id: messageId || threadId,
                  },
                  false,
                )
              }
            >
              Link {t.title} to {messageId ? "this message" : "whole thread"}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

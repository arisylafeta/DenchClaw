"use client";
import { useEffect, useState } from "react";
import type {
  WhatsappIdentityReview,
  WhatsappThread,
} from "@/lib/crm-postgres/whatsapp";
import styles from "./inbox/mail.module.css";
import { WhatsappTradeLinks } from "./whatsapp-trade-links";

const pageSize = 50;
export function WhatsappContext({
  personId,
  companyId,
  tradeId,
}: {
  personId?: string;
  companyId?: string;
  tradeId?: string;
}) {
  const [threads, setThreads] = useState<WhatsappThread[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const query = new URLSearchParams({
    ...(personId ? { personId } : {}),
    ...(companyId ? { companyId } : {}),
    ...(tradeId ? { tradeId } : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/whatsapp?${query}&limit=${pageSize}&offset=${offset}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error("Could not load WhatsApp chats");
        }
        const data = await r.json();
        setThreads(data.threads);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [query, offset]);
  return (
    <section className={styles.page} aria-label="WhatsApp chats">
      <div className="flex items-center justify-between gap-4 py-3">
        <h2 className="text-lg font-semibold">WhatsApp</h2>
        <a className="underline" href="/whatsapp/identities">
          Identity links
        </a>
      </div>
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Captured history only. Groups are shared context, not proof that every message concerns this
        contact{tradeId ? " or trade" : ""}.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>Loading chats…</p>
      ) : !threads.length ? (
        <p>No captured chats linked{tradeId ? " explicitly to this trade" : " to this profile"}.</p>
      ) : (
        <ul>
          {threads.map((t) => (
            <li key={t.id} className={styles.logRow}>
              <a
                href={`/whatsapp/threads/${encodeURIComponent(t.id)}`}
                className="flex items-center gap-3"
              >
                <strong>
                  {t.subject || (t.kind === "group" ? "Unnamed group" : "Direct chat")}
                </strong>
                <span className={styles.chip}>
                  {t.kind === "group" ? "Group · shared context" : "1:1"}
                </span>
                <span>{t.message_count} messages</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-3 py-3">
        <button
          className={styles.control}
          disabled={!offset || loading}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <button
          className={styles.control}
          disabled={threads.length < pageSize || loading}
          onClick={() => setOffset(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </section>
  );
}
export { WhatsappConversation } from "./whatsapp-chat";
export function WhatsappIdentityList() {
  const [identities, setIdentities] = useState<WhatsappIdentityReview[]>([]);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [people, setPeople] = useState<Array<{ id: string; name: string | null }>>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/whatsapp/identities?limit=${pageSize}&offset=${offset}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error("Could not load identity links");
        }
        setIdentities((await r.json()).identities);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
        }
      });
    return () => controller.abort();
  }, [offset, revision]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/whatsapp/identities?search=${encodeURIComponent(search)}`, {
        signal: controller.signal,
      })
        .then(async (r) => {
          if (!r.ok) {
            throw new Error("Could not search people");
          }
          setPeople((await r.json()).people);
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
  }, [search]);
  async function decide(identityId: string, decision: { personId?: string; unlinkId?: string }) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/whatsapp/identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityId, ...decision }),
      });
      if (!r.ok) {
        throw new Error((await r.json()).error || "Could not save decision");
      }
      setRevision((v) => v + 1);
      setSelected(null);
      setSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save decision");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={`bulk-trades ${styles.page} mx-auto min-h-screen max-w-4xl p-6`}>
      <h1 className="text-xl font-semibold">WhatsApp identity links</h1>
      <p className="my-3">
        Unmatched identities need confirmation. Names alone never prove who sent a message. Unlink a
        wrong decision before choosing another person. Chats remain readable.
      </p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {identities.map((i) => (
          <li key={i.id} className={styles.logRow}>
            <strong>{i.display_name || "Unknown identity"}</strong>
            <span className={`${styles.chip} ml-3`}>
              {i.links.length ? (i.shared ? "Shared identity" : "Linked") : "Needs confirmation"}
            </span>
            <p className="my-2 text-xs text-[var(--color-text-muted)]">
              {i.e164 || i.canonical_jid || i.id}
            </p>
            <div className="my-2 flex flex-wrap gap-3">
              {i.threads?.map((t) => (
                <a
                  key={t.id}
                  className="underline"
                  href={`/whatsapp/threads/${encodeURIComponent(t.id)}`}
                >
                  {t.subject || (t.kind === "group" ? "Group chat" : "Direct chat")}
                </a>
              ))}
            </div>
            {i.links.map((l) => (
              <div key={l.id} className="my-2 flex items-center gap-3">
                <span>
                  {l.name || "Company-only identity"} · {l.confidence}
                </span>
                <button
                  className={styles.control}
                  disabled={busy}
                  onClick={() => void decide(i.id, { unlinkId: l.id })}
                >
                  Unlink
                </button>
              </div>
            ))}
            {!i.links.length && (
              <div className="my-3 flex flex-wrap gap-3">
                {i.candidates.map((p) => (
                  <button
                    key={p.id}
                    className={styles.control}
                    disabled={busy}
                    onClick={() => void decide(i.id, { personId: p.id })}
                  >
                    Confirm {p.name || "person"}
                  </button>
                ))}
                <button
                  className={styles.control}
                  onClick={() => {
                    setSelected(i.id);
                    setSearch("");
                  }}
                >
                  Pick another person
                </button>
              </div>
            )}
            {selected === i.id && (
              <div>
                <label>
                  Find an existing person
                  <input
                    className={`${styles.control} ml-2`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <ul>
                  {people.map((p) => (
                    <li key={p.id}>
                      <button
                        disabled={busy}
                        className="my-1 underline"
                        onClick={() => void decide(i.id, { personId: p.id })}
                      >
                        Confirm {p.name || "Unnamed person"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-3 py-4">
        <button
          className={styles.control}
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <button
          className={styles.control}
          disabled={identities.length < pageSize}
          onClick={() => setOffset(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </main>
  );
}

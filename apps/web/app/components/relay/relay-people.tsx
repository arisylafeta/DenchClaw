"use client";

import { useCallback, useEffect, useState } from "react";
import type { PersonAddress, PersonSuggestion } from "@/lib/relay-people";
import { api } from "./relay-ui";
import w from "./relay-workspace.module.css";

type People = { address: string | null; also: PersonAddress[]; questions: PersonSuggestion[] };

const why = (a: PersonAddress) => (a.how === "alex" ? "you linked them" : a.evidence ? `they said so: "${a.evidence.slice(0, 140)}"` : "they said so");

/**
 * Under the person's name: their other addresses Relay counts as them, each with its reason and Unlink, and any "same
 * person?" question waiting on Alex. Nothing shows when there is neither.
 */
export function PeopleLine({ itemId, onError }: { itemId: string; onError: (text: string) => void }) {
  const [people, setPeople] = useState<People | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<People>(`/api/relay/items/${itemId}/people`).then((p) => { if (live) setPeople(p); }).catch(() => { if (live) setPeople(null); });
    return () => { live = false; };
  }, [itemId]);
  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try { setPeople(await api<People>(`/api/relay/items/${itemId}/people`, { method: "POST", body })); }
    catch (err) { onError(err instanceof Error ? err.message : "Couldn't save that."); }
    finally { setBusy(false); }
  }, [itemId, onError]);
  if (!people || (!people.also.length && !people.questions.length)) return null;
  return (
    <div className={w.people}>
      {people.also.map((a) => (
        <span key={a.address}>
          Also writes from <strong>{a.address}</strong> <span className={w.peopleWhy}>({why(a)})</span>{" "}
          <button type="button" className={w.quietLink} disabled={busy} onClick={() => void post({ unlink: a.address })}>Unlink</button>
        </span>
      ))}
      {people.questions.map((q) => {
        const other = q.address === people.address ? q.other_address : q.address;
        return (
          <span key={q.id}>
            Same person as <strong>{other}</strong>? <span className={w.peopleWhy}>{q.evidence || q.why}</span>{" "}
            <button type="button" className={w.linkbtn} disabled={busy} onClick={() => void post({ question: q.id, yes: true })}>Yes</button>{" "}
            <button type="button" className={w.quietLink} disabled={busy} onClick={() => void post({ question: q.id, yes: false })}>No</button>
          </span>
        );
      })}
    </div>
  );
}

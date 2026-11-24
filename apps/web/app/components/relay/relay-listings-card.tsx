"use client";

import { useEffect, useState } from "react";
import type { ListingProposalView } from "@/lib/relay-listings-core";
import { api } from "./relay-ui";
import w from "./relay-workspace.module.css";

/**
 * "Prepare listings and link": Relay's proposal for a seller who has agreed to list. Approve creates the draft listings
 * under ReBattery Sales with their photos and puts the one-click link in the reply; Not now puts the sell page there
 * instead. Nothing is published or sent from here.
 */
export function ListingsCard({ itemId, proposal, say, onChanged }: {
  itemId: string; proposal: ListingProposalView; say: (text: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const creating = proposal.status === "creating";

  // While the drafts are being made, look again every few seconds until the link is in.
  useEffect(() => {
    if (!creating) return;
    const t = setInterval(onChanged, 4000);
    return () => clearInterval(t);
  }, [creating, onChanged]);

  if (proposal.status === "declined") return null;
  const n = proposal.groups.length;
  const what = `${n} draft listing${n === 1 ? "" : "s"}`;

  const act = async (action: "approve" | "decline") => {
    setBusy(action);
    try {
      await api(`/api/relay/items/${itemId}/listings`, { method: "POST", body: { action } });
      say(action === "approve" ? `Creating ${what}…` : "The sell page is in the reply instead.");
      onChanged();
    } catch (error) {
      say(error instanceof Error ? error.message : "Couldn't do that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={w.listings} aria-label="Prepare listings and link">
      <header className={w.listingsHead}>
        <b>{proposal.status === "ready" ? `${what} prepared` : `Prepare ${what} and link`}</b>
        <span className={w.muted}>
          {proposal.status === "ready"
            ? `The link is in the reply${proposal.expiresAt ? `, valid until ${new Date(proposal.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. They set a password, accept the seller terms and add price and quantity.`
            : `For ${proposal.sellerEmail}, from what they sent, with their photos. Under ReBattery Sales until they claim them. Nothing is published.`}
        </span>
      </header>
      <ul className={w.listingsGroups}>
        {proposal.groups.map((g) => (
          <li key={g.label}><b>{g.label}</b> <span className={w.muted}>{g.facts.join(" · ")}</span></li>
        ))}
      </ul>
      {proposal.status === "failed" && <p className={w.error} role="alert">{proposal.error ?? "Creating the listings failed."}</p>}
      {creating && <p className={w.muted} role="status">Creating the listings and the link…</p>}
      {(proposal.status === "proposed" || proposal.status === "failed") && (
        <div className={w.listingsActs}>
          <button type="button" className={w.send} disabled={!!busy} onClick={() => void act("approve")}>
            {busy === "approve" ? "Starting…" : proposal.status === "failed" ? "Try again" : "Approve and create link"}
          </button>
          <button type="button" className={w.ghost} disabled={!!busy} onClick={() => void act("decline")}>Not now</button>
        </div>
      )}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { request } from "./trade-ui";

type Held = { holds: number; qty: number; whole: number; until: string | null; of: number | null };

const shortDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const count = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });

/**
 * On a supply listing's card: how much of the lot stored matches have reserved for buyers, and until when. Internal only:
 * the marketplace is not touched. Shows nothing when nothing is reserved.
 */
export function MatchReservation({ listingId, version }: { listingId: string; version?: string }) {
  const [held, setHeld] = useState<Held | null>(null);
  useEffect(() => {
    let live = true;
    request<Held>(`/api/bulk-listings/${encodeURIComponent(listingId)}/stored-matches/reservations`)
      .then((value) => { if (live) setHeld(value); })
      .catch(() => { if (live) setHeld(null); });
    return () => { live = false; };
  }, [listingId, version]);
  if (!held || held.holds === 0 || !held.until) {
    return null;
  }
  const what = held.whole > 0 || held.qty === 0 ? "Reserved for a buyer"
    : `Reserved ${count(held.qty)}${held.of != null ? ` of ${count(held.of)}` : ""} for ${held.holds === 1 ? "a buyer" : `${held.holds} buyers`}`;
  return (
    <p className="px-1 text-[12px] font-medium" aria-label="Reserved by matches">
      {what} until {shortDay(held.until)} <span style={{ color: "var(--color-text-muted)" }}>(internal, still on the marketplace)</span>
    </p>
  );
}

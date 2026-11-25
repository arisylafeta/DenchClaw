// Abandoned deals on the Deals board: why a listing stopped. Stored as the listing's closed_reason. Safe for client and server.
import type { ListingKind } from "./bulk-listing";

export type AbandonReason = "bought_elsewhere" | "no_longer_needed" | "not_a_fit" | "gone" | "other";

/** The reasons offered when a card is dragged to Abandoned, per side. All are existing closed_reason values. */
export const ABANDON_REASONS: Record<ListingKind, { value: AbandonReason; label: string }[]> = {
  demand: [
    { value: "bought_elsewhere", label: "Bought elsewhere" },
    { value: "no_longer_needed", label: "No longer needed" },
    { value: "not_a_fit", label: "Not a fit" },
    { value: "other", label: "Other" },
  ],
  supply: [
    { value: "bought_elsewhere", label: "Sold elsewhere" },
    { value: "gone", label: "Stock gone" },
    { value: "not_a_fit", label: "Not a fit" },
    { value: "other", label: "Other" },
  ],
};

/** Closed reasons that mean a deal was lost or stopped (not won, not housekeeping such as duplicate). A listing closed for
 * one of these after an offer went out shows in Abandoned even when it was closed somewhere else. */
export const LOSS_REASONS = ["bought_elsewhere", "no_longer_needed", "not_a_fit", "gone", "expired", "other"] as const;

export function isAbandonReason(kind: ListingKind, value: unknown): value is AbandonReason {
  return ABANDON_REASONS[kind].some((reason) => reason.value === value);
}

/** A closed reason as the board shows it. */
export function abandonReasonLabel(kind: ListingKind, reason: string | null | undefined): string {
  if (!reason) return "Closed";
  const known = ABANDON_REASONS[kind].find((item) => item.value === reason)?.label;
  if (known) return known;
  const text = reason.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

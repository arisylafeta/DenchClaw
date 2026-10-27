export const DEAL_OWNERS = ["Sean", "Alex", "Ari"] as const;
export type DealOwner = (typeof DEAL_OWNERS)[number];

/** The deal owner stored in a listing's context, or null when unset or not one of the three. */
export function dealOwner(value: unknown): DealOwner | null {
  return DEAL_OWNERS.find((owner) => owner === value) ?? null;
}

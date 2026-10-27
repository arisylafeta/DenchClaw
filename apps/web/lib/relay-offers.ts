// The offers ReBattery has made to ONE counterpart, as plain lines for Relay's reply drafting and its "before you send" check.
// Only this counterpart's offers are ever passed in: another buyer's price or the seller's identity must not reach their reply.

export type OfferRow = {
  name: string | null; stage: string | null; wants: string | null; terms: Record<string, unknown> | null;
  last_touch_on: string | null; last_touch_via: string | null; waiting_on: string | null; declined_reason: string | null;
};

const STAGE: Record<string, string> = {
  candidate: "Candidate (not yet offered)", offered: "Offered", contract_out: "Contract out", signed: "Signed", invoiced: "Invoice out",
  paid: "Paid", complete: "Complete", declined: "Declined", lost: "Lost",
};

export function offerLines(rows: OfferRow[]): string {
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const t = r.terms ?? {};
    const money = t.amount != null ? `${t.amount} ${[t.currency, t.unit ? `per ${t.unit}` : null, t.firmness].filter(Boolean).join(" ")}`.trim() : null;
    return `- ${r.name ?? "Offer"}: ${STAGE[r.stage ?? ""] ?? r.stage ?? "no stage"}${r.wants ? `; offered: ${r.wants}` : ""}${money ? `; their terms: ${money}` : ""}`
      + `${t.delivery_terms ? `; delivery ${t.delivery_terms}` : ""}${t.payment_terms ? `; payment ${t.payment_terms}` : ""}${r.declined_reason ? `; declined: ${r.declined_reason}` : ""}`
      + `${r.last_touch_on ? `; last touch ${r.last_touch_on}${r.last_touch_via ? ` by ${r.last_touch_via}` : ""}` : ""}${r.waiting_on ? `; waiting on ${r.waiting_on === "us" ? "us" : "them"}` : ""}`;
  });
  return `Offers made to this counterpart (use these, do not name the seller or any other buyer):\n${lines.join("\n")}`;
}

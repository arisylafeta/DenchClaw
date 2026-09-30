import "server-only";
import { CURRENCIES, cleanSpec, PRICE_UNITS, SPEC_LISTS, SPEC_LIST_KEYS, VOLUME_UNITS, parseDemandInput, type DemandInput } from "./bulk-demand";

const SYSTEM = `You read a pasted email or note in which a company asks to buy batteries, and fill a demand form.
Reply with ONLY JSON: {"buyer", "contact", "email", "wants", "quantity", "location", "kind", "needed_by", "volume",
"volume_unit", "max_price", "price_currency", "price_unit", "spec"}; null when not stated. Never invent a value.
- "wants": one plain line in the buyer's terms, e.g. "NMC EV packs 30-70 kWh for storage builds, up to ~EUR 20/kWh".
- "buyer": the buying company (else the person). "location": delivery country or region.
- "kind": "request" for a one-off need (a quantity wanted now or by a date), "standing" for ongoing or repeat buying.
- "needed_by": YYYY-MM-DD, requests only, only when a date or deadline is stated.
- "volume" + "volume_unit" (${VOLUME_UNITS.join(", ")}): the total for a request, per month for standing.
- "max_price" + "price_currency" (${CURRENCIES.join(", ")}) + "price_unit" (${PRICE_UNITS.join(", ")}).
- "spec": only these keys, each a list of values copied exactly from its options, only when stated:
${SPEC_LIST_KEYS.map((key) => `  ${key}: ${SPEC_LISTS[key].join(" | ")}`).join("\n")}
  and numbers kwh_min, kwh_max (per unit), min_soh (0-100); mixed_ok true/false.
  Storage systems (BESS, containers): formats "Systems", origins "Stationary storage", brand in system_brands, not makes.`;

/** Fills the Add demand form from pasted text, through the Hermes gateway. Values are for Alex to check. */
export async function fillDemandFromText(text: string): Promise<DemandInput> {
  const base = process.env.HERMES_API_BASE_URL ?? "http://127.0.0.1:8642";
  const key = process.env.HERMES_API_KEY;
  if (!key) throw new Error("The assistant is not configured here.");
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "hermes-agent",
      temperature: 0,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text.slice(0, 6000) }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error("The assistant could not read that text.");
  const content = ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The assistant could not read that text.");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const out: DemandInput = {};
  for (const key of ["buyer", "contact", "email", "wants", "quantity", "location"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 300);
  }
  // Each structured value is kept only if it passes the same checks as the form.
  for (const key of ["kind", "needed_by"] as const) {
    if (raw[key] === null || raw[key] === undefined) continue;
    const checked = parseDemandInput({ [key]: raw[key] }, false);
    if (!("error" in checked) && checked.value[key] != null) Object.assign(out, { [key]: checked.value[key] });
  }
  for (const [amount, ...parts] of [["volume", "volume_unit"], ["max_price", "price_currency", "price_unit"]] as const) {
    const group = Object.fromEntries([amount, ...parts].map((key) => [key, raw[key] ?? null]));
    const checked = parseDemandInput(group, false);
    if (!("error" in checked) && checked.value[amount] != null) Object.assign(out, checked.value);
  }
  const spec = cleanSpec(raw.spec);
  if (Object.keys(spec).length) out.spec = spec;
  if (out.email) out.email = out.email.toLowerCase();
  if (out.kind === "standing") delete out.needed_by;
  return out;
}

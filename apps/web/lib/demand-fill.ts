import "server-only";
import type { DemandInput } from "./bulk-demand";

const SYSTEM = `You read a pasted email or note in which a company asks to buy batteries, and fill a demand form.
Reply with ONLY JSON: {"buyer", "contact", "email", "wants", "quantity", "location"}; null when not stated.
"wants" is one plain line in the buyer's terms, e.g. "NMC EV packs 30-70 kWh for storage builds, up to ~EUR 20/kWh".
"buyer" is the buying company (else the person). Never invent a value.`;

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
  if (out.email) out.email = out.email.toLowerCase();
  return out;
}

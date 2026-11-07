// Runs the real apps/web/lib/buyer-suggestions.ts against a JSON fixture so the
// Python A0 port can be checked for parity. Reads a path argument:
//   { "supplies": [{ "id", "profile": SupplyProfile }], "buyers": [{ "id", ... }] }
// Writes { supplies: { id: [company_id...] } } to stdout.
import fs from "node:fs";
import { scoreBuyer, compareBuyers } from "../../../apps/web/lib/buyer-suggestions.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out: Record<string, string[]> = {};
for (const supply of input.supplies) {
  const scored = input.buyers
    .map((buyer: any, index: number) => {
      const fit = scoreBuyer(supply.profile, buyer.profile ?? {});
      return fit ? { buyer, fit, index } : null;
    })
    .filter(Boolean) as any[];
  scored.sort((a, b) => compareBuyers(
    { basis: a.buyer.basis ?? null, stage: a.buyer.stage ?? null, tier: a.buyer.tier ?? null, fit: a.fit },
    { basis: b.buyer.basis ?? null, stage: b.buyer.stage ?? null, tier: b.buyer.tier ?? null, fit: b.fit },
  ) || a.index - b.index);
  out[supply.id] = scored.map((row) => row.buyer.id);
}
process.stdout.write(JSON.stringify({ supplies: out }));

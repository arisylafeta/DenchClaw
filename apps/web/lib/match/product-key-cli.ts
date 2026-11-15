/**
 * Command line door to the product key builder, for Python tools that must write the same keys as the app.
 *
 *   echo '[{"make":"Vauxhall","model":"Corsa-e","kwh":50,"format":"pack"}]' | tsx lib/match/product-key-cli.ts
 *
 * Reads a JSON array of ProductFacts on stdin and prints one array of keys (most specific first) per input.
 */
import { productKeysFor, type ProductFacts } from "./product-key-for";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const facts = JSON.parse(await readStdin()) as ProductFacts[];
  if (!Array.isArray(facts)) {throw new Error("stdin must be a JSON array of ProductFacts");}
  process.stdout.write(`${JSON.stringify(facts.map((entry) => productKeysFor(entry)))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

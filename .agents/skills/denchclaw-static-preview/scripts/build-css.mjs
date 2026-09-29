// Compiles apps/web/app/globals.css with the app's Tailwind setup, scanning apps/web for classes.
// Usage (from apps/web): node <skill>/scripts/build-css.mjs <out.css>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const web = process.cwd();
const require = createRequire(join(web, "package.json"));
// postcss is a dependency of @tailwindcss/postcss, not of the app, so resolve it from there.
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const tailwind = require("@tailwindcss/postcss");

const from = join(web, "app/globals.css");
const result = await postcss([tailwind({ base: web })]).process(readFileSync(from, "utf8"), { from });
writeFileSync(process.argv[2], result.css);

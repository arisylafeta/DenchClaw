---
name: denchclaw-static-preview
description: Preview DenchClaw UI changes without a browser or deploy by rendering the real React components in jsdom with sample data, compiling the app's Tailwind CSS, and publishing one static page as a private Artifact. Use when someone wants to see a DenchClaw screen change before it ships. Not for QA of live behaviour.
---

# DenchClaw static preview

No browser may run on the ReBattery VPS, and a preview must never read production data. This
builds a faithful static picture of real components instead: the markup comes from the component
code on the branch, the styles from the app's own `globals.css` and Tailwind setup.

It shows layout, copy, colours and states. It does not prove behaviour: buttons do nothing except
the view switches you configure. Tests prove behaviour.

## Steps

Run from `apps/web`. `SKILL=../../.agents/skills/denchclaw-static-preview`, `OUT` = a scratch folder.

1. **Render.** Copy `$SKILL/examples/bulk-trades.preview.test.tsx` next to the component as
   `zz-preview.test.tsx` and adapt it: stub `fetch` with sample data (never production rows; the
   design canvas's illustrative data or obviously synthetic data), fake the date with
   `vi.setSystemTime` when labels depend on it, render, drive the UI with `fireEvent`, and write
   `document.body.innerHTML` to `$PREVIEW_OUT/<view>.html` for each screen. Then:
   `PREVIEW_OUT=$OUT NODE_ENV=test npx vitest run <path>/zz-preview.test.tsx` and delete the copy.
   Never commit it.
2. **Compile CSS.** `node $SKILL/scripts/build-css.mjs $OUT/app.css`. Tailwind scans `apps/web`,
   so classes used only in the rendered components are included.
3. **Assemble.** `python3 $SKILL/scripts/assemble.py --css $OUT/app.css --out $OUT/preview.html
   --title "<Screen name>" --view list=$OUT/list.html --view board=$OUT/board.html
   --nav $SKILL/examples/bulk-trades.nav.json --note "Sample data. Other buttons are inert."`
   See the script's docstring for nav rules. The page follows the viewer's light or dark theme.
4. **Publish** `preview.html` with the Artifact tool (private by default). Republish the same file
   path to keep the URL. Say in one line what the sample data is and what is inert.

## Checks before publishing

- `grep -o '<div data-view=' preview.html | wc -l` matches the number of views.
- Every sample value is from the design or obviously synthetic. No names, emails, phone numbers or
  prices invented to look real.
- A rendered view that is empty usually means the test wrote before `await screen.findBy…` settled.

## Traps

- Run vitest with `NODE_ENV=test`; the shell here inherits `NODE_ENV=production`.
- `postcss` is not a direct dependency of the app; `build-css.mjs` resolves it through
  `@tailwindcss/postcss`.
- New CSS tokens must be scoped (for Bulk Trades, under `.bulk-trades` in `globals.css`) and have
  dark values under `.dark`, or the dark preview shows light colours.

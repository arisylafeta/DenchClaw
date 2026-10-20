# Trades Preview: Story & Description Handoff

For agents assigned a batch of demand rows in Trades Preview. Goal: make each
row's title, description and Story read as the clean, true, at-a-glance
account of that opportunity — the thing a human partner reads instead of
re-researching the deal from scratch.

Start here: https://crm.rebattery.io/?path=~trades-preview (filter to your
assigned company/companies, or open each demand link you were given directly:
`https://crm.rebattery.io/?path=~trades-preview&demand=<id>`).

## What "shaped up" means

- **Title**: short, specific, listing-style. Not the raw spec dump. Examples
  already done: "Two 60-80kWh EV Packs, Grade B OK", "VW Group MEB Packs, 55 /
  62 / 82kWh", "8x Ioniq 5 77.4kWh Packs". Max ~60 characters.
- **Description**: the first thing someone reads to understand the deal —
  what's wanted, why, and the one or two facts that matter. Not a restatement
  of every field. Tighten, correct, de-duplicate. If something recorded is
  wrong or stale, fix it at the source (see below) rather than overriding it
  in a way that leaves the old wrong text elsewhere.
- **Story**: the real sequence of what happened — email, call, research,
  document — each with an accurate title, a short factual body, the real
  date, and a link to the original source where one exists. Not noise, not
  speculative framing.

## Where this data actually lives (don't invent a new store)

| What | Field | How it's used |
|---|---|---|
| Title override | `demand.context.listing_title` (string) | `demandTitle()` uses it verbatim if set, else derives from `wants` |
| Intended use / application | `demand.context.application` | First line of the auto description |
| Internal notes | `demand.note` | Appended to the auto description |
| Buyer context notes | `crm_company_context_notes` via `demand.context_notes` | Appended to the auto description (first 3) |
| Missing documents | `demand.context.missing_documents` (string[]) | Called out in the auto description |
| Raw spec/ask | `demand.wants`, `demand.spec` (jsonb) | Source of truth; don't rewrite this unless it's factually wrong |
| Story entries | `crm_bulk_trade_demand_activity` (kind, title, body, ref_kind, ref_id, occurred_at) | Rendered as the Story timeline |

The description shown in the UI (`demandDescription()` in
`apps/web/lib/bulk-demand-header.ts`) is **assembled automatically** from the
fields above, capped at 200 words. You don't edit the rendered text directly
— you edit the underlying fields and the assembly produces a better result.
If the automatic assembly itself reads badly (wrong order, redundant), flag
it to Devon rather than fighting it with field content.

Activity kinds available: `note`, `research`, `outreach`, `call`, `quote`,
`supply`, `status`, `document`, `mail`, `whatsapp`. Use `document` for
prepared documents (RFQs, proposals) that were previously mislabeled as
`research`.

## How to edit

**Via the UI** (simplest, for one-off title/note fixes): open the demand in
Trades Preview, use Edit/status tools where available. Note: the pencil Edit
button is gone from Trades Preview by design (manual edit sheet removed,
"we're gonna use AI to change things") — for now, field edits other than
status go through the API or DB directly.

**Via the API** — `PATCH /api/bulk-trades/demand/{id}`:
- Body is the fields to change, e.g. `{ "context": {...} }`, `{ "note": "..." }`.
- **`context` REPLACES the whole object, it does not merge.** Always `GET`
  the current demand first (`GET /api/bulk-trades/demand/{id}`), copy its
  existing `context`, add/change only your keys, then PATCH the full merged
  object back. Patching a bare `{ listing_title: "..." }` will silently wipe
  `application`, `missing_documents` and anything else already recorded.

**Story entries** — `POST /api/bulk-trades/demand/{id}/activity`:
- Body: `{ kind, title, body?, refKind?, refId?, occurredAt? }`.
- `occurredAt` should be the **real event date**, not today, when you're
  backfilling a past email/call/document.
- Use `refKind`/`refId` to link real evidence (a URL, a linked lot/supply
  record) wherever you have it. Don't fabricate a link.

**Via Postgres** (bulk work across many rows): local `denchclaw` DB,
`crm_bulk_demand` (typed view over `crm_bulk_listings`) and `crm_bulk_listing_activity` (`bulk_listing_id`). Back up
the table before any bulk UPDATE (`pg_dump -t <table> denchclaw > backup.sql`,
verify it's non-empty) and use `context = context || jsonb_build_object(...)`
to merge rather than overwrite.

## Rules (same as the rest of this project)

- **No fabrication.** Only use what you can verify from the demand's own
  records, linked company context, or real correspondence/call notes you can
  see. If something is unknown, say so or leave it blank — don't guess a
  number, a date, or a reason.
- **Preserve originals and evidence.** Don't delete the raw `wants`/`spec`
  text or overwrite a source quote; correct alongside it, not over it.
- **A failed deal must not auto-close the underlying demand or supply.**
  Don't change `status` as a side effect of cleaning up text.
- **Distinguish drafted / sent / replied** for email activity where you can
  tell the difference — record it in `data.state` (`"draft"` / `"sent"`),
  don't guess "replied" if you can't actually see a reply.
- **Company-wide correspondence is not automatically about this specific
  request.** If an email thread covers several things, only log the part
  that's actually about this demand as Story for this demand.
- This is **production CRM data**. If you're running bulk SQL rather than
  one-off UI/API edits, back up first and do a small test batch before the
  rest.

## Scope

- Open demand only (`status = 'open'`). Don't touch qualifying/closed/history
  rows as part of this pass unless separately asked.
- One demand = one title, one description, one Story. Don't merge two
  demands' stories together even if they're clearly related — a match is a
  link, not a merge (see `crm_bulk_trade_demand_matches`).
- If you think a demand doesn't belong in Trades Preview at all (duplicate,
  wrong status, actually closed), flag it — don't silently reclassify.

Questions or something doesn't fit this handoff: ask Devon/Ari rather than
improvising a new convention.

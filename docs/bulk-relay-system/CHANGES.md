# Bulk and Relay system: change note

For Ari, 12 Nov 2026. Branch `bulk-relay-system` (DenchClaw), six slices. Details per slice are in the notes beside this one.

## What changed, per slice

1. **Foundation** (foundation.md). Every stage change of a listing or offer is logged in `crm_bulk_stage_events` by database triggers, so app, agent and SQL writes are caught alike. Offers carry quantity and the paid facts (paid on, amount, currency, take); Paid and Complete need all five, and the database refuses them otherwise, whoever writes. Stages are computed, never stored, and no longer read the retired `crm_bulk_trade_*` match tables. Requests and Supply lists plus a Deals board; one take target (£15,000, Dec to Feb).
2. **Front door** (front-door.md). Bulk is 300 kWh or more, or over USD 20,000. Each lead card gets a route (bulk, marketplace, Jules, recycling) with a reason. A bulk lead's deal opens when Alex's first reply has actually gone. Qualified is a per-route checklist a person checked, plus a person's tick.
3. **Next step** (next-step.md). One chase clock for lead and deal threads, match asks and offers: working day 1, 3 and 5, a reply stops it, parking proposed after the third; other threads keep the old 7-day nudge and get no drafted chase. Chases are drafted into Review by the scan, never sent, and a reply (checked again at the Send click) drops them. Today shows overdue next steps by owner, deals stuck in New, the active deal limit and whose move it is. Team notes with @mentions; one email and WhatsApp history per deal.
4. **Stored matching** (matching-design.md, "As built"). A person starts a run; five candidates are stored in `crm_bulk_matches` with reasons, asks, yes or no, and quantity reservations, counted in units, that a trigger keeps within what the candidate has. A reservation's date applies only while the offer is at offered; past that it holds until the offer ends.
5. **Offer to close** (offer-to-close.md). An offer to a buyer needs a confirmed, in-date seller quote, checked again at send and on a hand move to Offered; the next-step rules hold in the API too. A change of price or terms drops the open draft and its sheet, and an out-of-date draft is not sent. Price sheets (.xlsx) are made from CRM prices and stored with the deal. Margin shows to staff and prefills take.
6. **Scorecard** (scorecard.md). Eleven measures for the week and the quarter: a read-only command that prints them and writes the Monday message, and a Scorecard block on Today. The "Pipeline against the take target" meter stays: it is weighted pipeline, not take banked, so it does not duplicate measure 10.

## Migrations, in order

They follow main's `111_relay_draft_ways.sql` (Relay's ways to answer). They were 111, 112, 113 and 115 on this branch before main took 111; none had been applied anywhere, and the data markers they write moved with them ("As of migration 116", `qualified_by = 'before migration 117'`).

| # | What it does to existing live rows when applied |
|---|---|
| 116 | Adds the event table and five offer columns. Moves any numeric `terms.quantity` into `quantity` and any `data.take_gbp` into `take_gbp`, removing the old keys. Writes one starting event (note "As of migration 116", actor `system`) per open listing and per staged offer on an open listing. From then on triggers log changes; an offer reaching Complete closes a listing only when it sold all the listing states in the same unit (request `bought_from_us`, supply `sold`), else notes "Part sold: N of M" or that it needs closing by hand; and no writer can set Paid or Complete without the five paid facts. Existing Paid or Complete rows without them are not touched. |
| 117 | Adds route, Qualified tick and checklist columns. Every open listing the old rule qualified gets `qualified_at = now()`, `qualified_by = 'before migration 117'` and keeps Qualified; no stage event is written for it. Then the new Qualified rule replaces the old one. |
| 118 | Creates `crm_bulk_matches` and its triggers, and a trigger on offers that reserves or releases a matched offer's quantity. Changes no existing rows. |
| 119 | Adds `relay_item.chase`, `relay_draft.chase_after` and `gmail_copy_left`, the one-open-chase index and the mentions index. A qualified deal now stays Qualified until a match run starts. It then runs `bulk_stage_check_all()` once: deals the old owner rule had moved on get a "back to Qualified" event from `system`, and any other open listing whose stage drifted (for example a hold that ran out) gets its event too. |

Rollback: there are no down migrations. `rollback.sql` (not applied by anything) drops the new triggers and restores the pre-116 stage functions for the old web build; `rollback.md` says when and how.

## Merged with main's Review rewrite

- Main's one-page Review (ways to answer, gaps to fill, "say what to change", tools closed under the card) is the Review screen now; this branch's controls were fitted into it. A chase Relay prepared shows as one: its tag reads "Chase N of 3", the chase clock line sits under the reply, Don't chase (and Park, once three chases went unanswered) sit beside Done, no reply, and the "copy still in Gmail drafts" warning shows on the card as well as in Follow up. A prepared chase gets no other ways to answer: the page does not ask for them and `relay-ways.ts` refuses them, so no written way can replace a text that passed `verifyChase`.
- The deal checklist with Mark checked, They can't provide it, Mark Qualified, the No price / No date tags and the parking suggestion is under the card's "Deal checklist" tool (closed until opened) instead of beside the draft; the deal bar stays on the inbox card. At Send and Send later the chase-answered check runs before main's gap check.

## Other changes to know before deploying

- **`RELAY_AUTO_DEAL_UPDATE`** (default on; `off`, `false`, `0` or `no` turns it off). In the web app it stops only the automatic "Update deal from this reply" jobs. In the inbox scan it skips the scan's call to the web app altogether, which is also the only place chase drafts are prepared.
- **The scan now calls the web app** after each `--apply` run: `POST http://127.0.0.1:3100/api/relay/internal/deals` with the bearer secret in `/root/.hermes/workspace/secrets/relay-internal.secret`, 150-second timeout. The web app then settles sent lead cards (opening their deals), queues reply updates, prepares up to 3 due chase drafts and marks new supply for standing requests. A failure is reported and never fails the scan.
- **Two patches, not applied**, both for the `/root/.hermes` repository (`git -C /root/.hermes apply <patch>`; both pass `--check` today): `patches/matcha-bulk-line-and-routes.patch` (Matcha's intake, creating-listings and RECIPE move from EUR 20k to the new bulk line and routes) and `patches/jules-supply-one-row-per-lot.patch` (the Jules supply sync folds repeat leads into one listing per seller, product and quantity, with a test).
- **Not scheduled**: the daily `bulk_stage_check_all()` and `bulk_matches_expire()`, and the Monday scorecard. The proposal is in scorecard.md.

## Built, not wired

- **WhatsApp-triggered deal update**: `queueWhatsAppUpdates` (`lib/relay-whatsapp-update.ts`) is tested but called by nothing.
- **Marketplace price check**: `priceOfRecord` and `comparePrices` are tested against an injected price source; nothing calls them, as no local copy of a deal's marketplace price exists.
- **Price sheet attachment**: the mail tool cannot attach a file to a draft. The .xlsx is stored in the deal's Documents and the email carries its lines as text; to send the file, download it and attach it in Gmail.

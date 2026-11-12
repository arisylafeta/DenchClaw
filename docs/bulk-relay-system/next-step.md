# Next step, always prepared

For Ari, 12 Nov 2026. What slice 3 adds (migration `119_next_step.sql`, `apps/web/lib/chase-clock.ts`, `relay-chase.ts`, `relay-chase-core.ts`, `bulk-today.ts`, the Today tab and the deal's History tab).

## The chase clock

One clock for what we chase: lead threads (a lead card not marked "not a lead") and threads linked to a deal in Relay, supplier confirmations and seller re-confirms from stored matches (`asked_at`, `chases`), and offer emails. Every other thread Alex wrote last on (the accountant, investors) keeps the older rule exactly: shown in Follow up after 7 working days, dropped to Other after two unanswered nudges, and no clock, so no chase is drafted.

- Chases fall due on **working day 1, 3 and 5** after our first unanswered message (Monday to Friday, London dates, no bank holidays). The day we wrote is day 0.
- A reply from them stops it at once.
- After the third chase and one more working day of silence, **parking is proposed**: a "Park" button on the Follow-ups row. It is "Don't chase" plus a note on the linked deal. Never automatic.
- Code: `chaseClock()` in `lib/chase-clock.ts`. The scan has one mirror, `chase_clock()` in `relay_scan.py`. `lib/chase-clock.cases.json` holds the cases, and both test suites run every one, so the two cannot drift.
- Only Relay's chase drafts count as chases sent. A second email of ours on the same day, or a correction, is not a chase.
- Replaced: the 3 working days on offers (`chaseDue` now calls the clock), and the scan's 4 days for deal threads. The 21 days "quiet" on the OKR page and 7 on the home page stay as counts only; they chase nothing.

## Where chase drafts come from

- Every scan (6 an hour) writes the clock onto each lead or deal thread Alex wrote last on (`relay_item.chase`), then calls the web app (`POST /api/relay/internal/deals`, internal secret, port 3100). Off with `RELAY_AUTO_DEAL_UPDATE=off`; a failure never fails the scan.
- That call opens deals from sent lead cards, queues "Update deal from this reply", and turns each due chase into a draft in Review (`prepareChases`, at most 3 a call).
- A chase draft is fixed parts: "Hi <first name from the thread>," one set line per chase, "Best, Alex". No model writes it. `verifyChase` refuses any number, day, month or money not in the thread or deal, a greeting name not in the thread, and any name of the deal's other side.
- One open chase draft per thread (a unique index). Each chase on the same unanswered message is prepared once, so a dropped draft does not come back. A reply skips the open draft and cancels a send-later on it, unless the send runner has already claimed that send. A reply counts when it was sent after our message the chase follows (`relay_draft.chase_after`), however late it synced, and Relay checks again at the Send click. A skipped chase that had been copied to Gmail drafts stays there (Relay cannot delete it), and the email's row says "A copy of this chase is still in Gmail drafts". Only the scan prepares chases; opening the inbox only skips answered ones. Nothing is sent: a person sends it from Review. "Don't chase" works there too and is remembered.
- A sent chase on a thread that carries a stored match's ask adds one to that match's `chases`.

## New columns

| Where | Column | What it holds, and why |
|---|---|---|
| `relay_item` | `chase` (jsonb) | The scan's reading of the clock: state (waiting, due, park), chases sent, working days waited, the chase due next, since when. The chase pass and the Follow-ups row read it. |
| `relay_draft` | origin `predraft` (value allowed since 100) and index `relay_draft_one_open_chase` | A chase Relay prepared by itself; at most one open per thread. |
| `relay_draft` | `chase_after` (timestamptz), `gmail_copy_left` (boolean) | When our message the chase follows was sent, so any later reply skips it; and a skipped chase whose Gmail copy is still in Gmail drafts. |
| `crm_bulk_listing_activity` | no column: `data.mentions`, `data.ticked` on kind `note` | Team notes with @Alex, @Sean, @Ari. A mention stays on that person's Today until they tick it. No email or WhatsApp. |

Function `bulk_listing_match_started(id)`: a qualified deal now stays Qualified until a person starts a match run (or it has a live match); an owner alone no longer moves it.

## Today and History

- Today: active deal warning per owner over 20; mentions; "Stuck in New" (more than 7 days, Move on or Remove with a reason); overdue next steps grouped by owner; "Waiting on them / us · N working days" on each row from the last real message on the deal's linked email threads, offer threads and WhatsApp chats.
- Leads past 2 working hours (Mon to Fri, 09:00 to 18:00 London) sort to the top of Relay's leads lane, age in red.
- History: team notes, then one conversation of email and WhatsApp in time order, with sender and readable text (links kept as words and address).

## Built, not wired

WhatsApp: `queueWhatsAppUpdates` (`lib/relay-whatsapp-update.ts`) queues "Update deal" for a new inbound message in a linked chat, tested, but called by nothing: the ingestion has no hook this slice may change, and the job needs a Relay email on the deal.

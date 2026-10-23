# ReBattery CRM authentication deployment

The production CRM has exactly two invite-only application users. Bootstrap requires a different runtime password for each account:

- `CRM_BOOTSTRAP_PASSWORD_ARI` for `ari@rebattery.io`
- `CRM_BOOTSTRAP_PASSWORD_ALEX` for `alex@rebattery.io`

Both variables are required, must contain 12 to 1024 characters, and must not have the same value. Inject them from the approved runtime secret source immediately before running `pnpm --dir apps/web db:auth:bootstrap`. Never put their values in Git, deployment logs, shell transcripts, or chat.

The bootstrap hashes each password independently and only writes the matching hash to its allowlisted account. It also reactivates those accounts, clears login lockouts, reconciles actionable Work Task assignments, and removes assignments from Done or Retired tasks.

## Production access topology

`https://crm.rebattery.io` is the primary CRM entrypoint. nginx terminates public TLS and proxies the application without nginx Basic Auth. DenchClaw application sign-in is the only interactive access gate: there is no public signup, and only the two pre-provisioned allowlisted accounts may authenticate.

The application must keep every non-public page and API route behind its database-backed session middleware. Unsafe mutations require a same-origin request. The intentionally public surface is limited to the login and session-establishment route, required OAuth callbacks, inbound webhook routes, and static login assets. User-scoped email and Work Task authorization remains server-side and default-deny.

Keep the exact `/api/formbricks-buyer-sourcing-webhook` nginx route public and proxied to its dedicated loopback service. Keep Tailscale Serve as a private operational fallback to the loopback-only CRM runtime; it is not the canonical public hostname. Never restore shared nginx credentials or enable public signup.

## User activity leaderboard

The authenticated CRM Leaderboard requires `CRM_DB_BACKEND=postgres`. It reads `crm_user_activity_snapshots` (migration `042`), never PostHog, on request. `scripts/rebattery/leaderboard_snapshot.py` fetches PostHog once daily (05:30 UTC via `rebattery-leaderboard-snapshot.timer`, templates under `scripts/rebattery/systemd/`) using `~/.posthog/credentials.json`, retries 5xx/429, and replaces the 7/30/90-day snapshots in one transaction only on success. `/api/leaderboard/health` reports snapshot age (`stale` after 36 hours).

Activity aggregates are cached in memory for 15 minutes per 7/30/90-day window. Names and emails are joined only inside the CRM, never sent to PostHog. Missing account-link tables show PostHog-only rows with “Link pending”; a failed or partial activity query shows an error rather than zero activity. The health endpoint `/api/leaderboard/health` requires a CRM session and returns connection status and latency, not credentials.

Scoring version 1 weights submitted offers, buy-now and auction bids highest; sourcing requests and submitted messages next; saved searches/listings, quote starts and documentation clicks next; listing clicks lowest. Submitted and succeeded events are not double-counted. The score applies a 14-day recency half-life to window intent; engagement breaks ties. “No offer yet” means no submitted offer/buy-now/bid ever recorded. Never active means no eligible PostHog events ever; dormant means last activity at least 30 days ago; cooling means 7–29 days ago. Active accounts created within seven days are new; rising means at least three events in the latest week and over 1.5 times the preceding week. Counts honor role/search/CRM/no-offer filters but precede the segment filter and pagination.


## Hermes chat profiles

DenchClaw selects the active Hermes profile with the `/p/<profile>/api/sessions`
prefix for both session creation and chat. The host gateway must serve that
profile; never fall back to the default profile when routing fails, because it
would change the chat's identity and history.

Keep messaging credentials on their owning profile. In this deployment, default
owns the Discord bot; named CRM profiles must not contain copies of its
`DISCORD_BOT_TOKEN`. Duplicate bot credentials can make Hermes' startup guard
leave the gateway in single-profile mode, causing named-profile requests to
return `404 Unknown or unconfigured profile`. Inspect
`hermes gateway migrate --multiplex --dry-run`, back up affected settings, and
resolve credential ownership before an authorized migration/restart.

Each named profile also needs an explicitly provisioned `API_SERVER_KEY` that
authorizes the trusted DenchClaw service's `HERMES_API_KEY`. Hermes deliberately
does not inherit the gateway owner's API key for `/p/<profile>/` requests.
This local API authorization is separate from Discord or provider credentials;
do not copy those credentials to resolve an API authentication failure.

The Hermes adapter emits AI SDK `UIMessageChunk` events. An error chunk contains
`type: "error"` and `errorText`, not an HTTP `status` property. Preserve the
upstream failure text without turning it into a client schema-validation error.
The adapter regressions parse the stream through `DefaultChatTransport`, the
same strict validator used by the chat client.

## CRM sidebar icons

Sidebar icons are profile-local workspace settings, read from the `icon` key in
`<workspace>/<object>/.object.yaml`. The live workspace files are intentionally
Git-ignored; keep the non-secret icon choices here rather than committing CRM
data or complete profile directories.

| Object | Lucide icon |
| --- | --- |
| Bulk Trades (`bulk_trade`) | `handshake` |
| Dismantlers (`dismantler`) | `wrench` |
| Stocks (`stock`) | `boxes` |
| Work Tasks (`work_task`) | `clipboard-check` |

These settings are applied to all four objects in the default and outbounder
workspaces, and to the existing Bulk Trades and Work Tasks objects in the
the-enricher workspace. Preserve every other YAML key and do not create missing
objects merely to set an icon.

Use the CRM icon picker or authenticated `PATCH /api/workspace/objects/<name>/icon`
with `{"icon":"<Lucide icon>"}` for the active profile. The sidebar retains its
existing 16px outline style. Refresh the CRM after changing metadata; no build
or redeploy is required.

## Mail identity visibility

Mail visibility follows the identity, not the Gmail account that captured it.
`alex` and `ari` are private to their matching application user, including legacy
ownerless rows carrying a stale `shared` label. Every other configured identity
(Supply, Support, Hello, Enterprise) is shared between authenticated CRM users,
including mail captured through a founder's Gmail alias. Capture owner, labels
and original provider records remain unchanged.

For unclassified mail, retain a known capture owner's privacy. Ownerless messages
addressed to or sent by a founder remain private to the corresponding participant;
only non-personal ownerless legacy mail explicitly labelled `shared` is shared.
Lists, identity counts, individual messages, draft reads, thread messages and
participants, follow-ups, and attachment authorization use the same predicate in
`lib/mail-scope.ts`. Internal-mail and CRM-only display filters remain separate.

## Shared CRM discovery views

Companies and People have shared `Buyers` and `Dismantlers` saved views. Migration
`023_saved_purpose_views.sql` stores their definitions, active selection and view
settings in `crm_object_views`, keyed by the registered CRM object. Apply it only
after a current database backup. Reapplying the migration preserves user refinements
and intentionally deleted views.

Both views filter a read-only, computed `Purpose` field. Buyer membership includes
all `Supply Update` and `New to Supply Updates` contacts, buyer/repurposer purpose
tags, existing buyer roles and profile signals, and linked companies or people.
There is no import-date or research-cohort restriction. Unlinked newsletter contacts
remain in People; companies without contacts remain in Companies. Dismantler
membership uses the existing dismantler directory and purpose tags/roles, plus linked
people. A record can have both purposes. Internal records are excluded.

These are broad discovery views, not sending audiences or qualification decisions.
Opt-out and exclusion flags remain visible. Viewing or refining them does not
subscribe contacts, change classifications, or send messages. The dedicated
Dismantlers workspace and its outreach stages remain unchanged.

Migration `024_private_view_scopes.sql` keeps saved filters for email threads,
email messages, interactions and Work Tasks in `crm_private_object_views`, keyed
by object and authenticated user. Anonymous callers cannot read or write this
metadata. Companies and People remain shared.

Selecting a view or resizing columns updates only selection/settings; it never
resubmits stale view definitions from another tab. Computed multi-value Purpose
cannot be used as an editable Kanban grouping or scalar timeline grouping.

## Shared data tables and People interface

`app/components/ui/data-table.module.css` owns the compact, square `--bt-*`
data-table presentation: headers, cells, hover/selection, focus, toolbars,
search, pagination, empty/loading states and portaled menus. `DataTable` and
`ObjectTable` apply it by default for People, Companies and custom objects;
there is no People-only presentation switch. Campaigns, Company opportunities,
Cron, database previews, onboarding, platform administration and the operational
trade/demand/dismantler column grids consume the same contract. Existing sorting,
filters, edits, selection, resizing and paging stay in their existing engines.
Email HTML, code diffs, boards, timelines and non-tabular lists are outside this
scope; badges and avatars keep their meaningful shapes.

Bulk Trades Demand and Supply details open in a right-hand modal sheet, preserving
the full-width list and its filters. The shared Radix Sheet handles focus trapping,
Escape, overlay dismissal and return focus. Demand edits use a scrolling form with
a fixed Save/Cancel footer, titled field groups and shared Radix Select controls.
The fee hint and inbox proposal writer share `lib/bulk-demand.ts:demandFee`;
the hint does not change the saved override. Qualification appears only for
qualifying demand. Activity uses compact kind segments and a linked timeline.
Demand History includes only Sold (`bought_from_us`), Lost (`bought_elsewhere`)
and Dropped (`no_longer_needed`) outcomes, newest update first. Its date is the
record's last update timestamp; there is no separate closure timestamp.


`ui/table-cell.tsx` owns leaf-cell disclosure. Cells—including Notes, tags and
relations—start on one line. Overflowed values expose a keyboard-operable
chevron and expand on a plain content click; repeat click or Escape collapses
them. Expansion is local UI state, never a save. Links, record navigation,
double-click editing, selection shortcuts and controls keep their own actions.
Expanded tag and reverse-relation cells reveal the full retained collection.
Native table cells and operational grid columns share the same primitive;
structural detail/empty rows and active editors are not clamped. A shared resize
observer updates overflow affordances after column resizing.

`PersonProfile` keeps its square header, tabs, overview and notes. Campaigns
groups sends by campaign identity into a five-column results table. Each campaign
starts closed; a keyboard-operable disclosure reveals per-send and destination
evidence. Lifetime listing engagement is separately collapsed. Raw IDs, CTA keys
and sync metadata are not shown. Unknown, unobserved and unsent evidence remain
distinct, and disclosure state resets on person navigation.

`lib/crm-postgres/person-profile.ts` resolves cached listing metadata in one
batched local `crm_bulk_trade_lots` read. Campaign detail and Person profiles share
`cachedListingMetadata` and `canonicalListingUrl`; only validated public listing
URLs are returned, never raw recipient redirects. Missing cache data uses an
honest readable fallback. Historical email first observations remain first;
pending tracking stays unknown. No schema, provider calls, tracking capture,
authorization or mutation behavior changes.

## Campaigns workspace

Campaigns has a dedicated full-width workspace page at `/?path=campaign`, with
detail selected by `entry=campaign:<id>`. It does not use the generic object
properties sheet or require a visible campaign node in the file tree. The tab
model owns campaign selection, direct links and browser-history restoration.
Saved Campaigns tabs normalize before activation, including tabs inactive at
reload.
The UI reuses Dismantlers' square `--bt-*` surfaces and shared trade controls.

Authenticated, PostgreSQL-only reads use `/api/campaigns` and
`/api/campaigns/[id]`, backed by `lib/crm-postgres/campaigns.ts`.
`/api/campaigns/[id]/activity` independently reads website evidence through
`lib/campaign-activity-server.ts`, `lib/crm-postgres/campaign-activity.ts` and
`lib/campaign-posthog.ts`. Existing session middleware and the shared CRM read
guard remain default-deny; activity responses are private and uncached. No
recipient data or audit metadata is added to the public surface.

Historical saved campaign metrics retain snapshot provenance; native
`dench-campaign` metrics derive from accepted sends and recorded provider/CTA
observations. Pending tracking is not proof of no engagement. General CTAs do
not count as listing engagement, and per-listing counts deduplicate recipients.
Listing titles and canonical auction links can use the existing local
`crm_bulk_trade_lots` cache; this read never follows tracking redirects or calls
the marketplace provider. Technical fields and notes are shown only under
Details. This page adds no schema, sending, tracking capture or scoring changes.

Lot-buyer email tracking and auction synchronization attribute clicks only through
`mail_message_link.first_clicked_at` for the matching listing. The provider's
message-wide click timestamp must never stand in for a listing click. A multi-lot
send supplies invitation evidence for its primary listing and every listing CTA;
general links supply neither listing clicks nor extra listing invitations. The
normal synchronization path refreshes stored buyer evidence; this change does not
run a backfill, send messages, or change tracking capture or schema.

Listing count links open square right-side people sheets, filtered by destination
and email/browser/submission source, with local identity search and 25-row
pagination. Listing and general-destination email evidence comes from the
ordinary CRM detail ledger and remains available if PostHog or its private
manifest fails. Submission sheets use the selected kind's latest timestamp.
Original snapshot totals are never replaced with retained-cohort counts.
Unknown attribution, provider failure and recorded zero remain distinct.

Email sheets retain the native email-clicked cohort but enrich each record with
separate PostHog redirect-event counts and last click/view times. A tracked-click
sheet includes all retained records with observed redirects, including records
outside the earlier email snapshot. Click timestamps use the latest redirect
event, never a page view or submission. Browser sheets show page/session counts
and last view. Missing provider attribution remains unknown, not zero or a
manufactured last-click timestamp.

Website attribution joins private send-manifest identities to retained accepted
sends using both person ID and immutable send email. Only opaque link IDs enter
the PostHog query; API responses contain CRM person IDs and aggregate activity,
not manifest emails, tracking URLs, provider identities or session IDs. Reads
cover at most 30 days from the accepted-send/campaign window and reject capped
or invalid provider results. Distinct sessions and recipients are deduplicated
across destinations; per-destination rows can overlap. A browser event does not
verify the named recipient, and consent gaps do not imply a bot. No conversion
rate or human/bot score is inferred.

Keep provider credentials and manifests outside the release artifact.
`CRM_POSTHOG_CREDENTIALS_PATH` defaults to `~/.posthog/credentials.json`, must be
a regular non-symlink file with mode `0600`, and is restricted to PostHog project
`375247` on its US/EU API hosts. `CRM_CAMPAIGN_MANIFEST_PATH` can select a private
manifest; otherwise `CRM_CAMPAIGN_MANIFEST_DIR` defaults to
`~/.hermes/workspace/campaigns` with bounded shallow discovery. Missing,
invalid or ambiguous manifests fail closed. Next.js tracing excludes these
runtime paths; deployment must leave them private and available to the service.
The page shows the provider's observed refresh/receipt time and queried period,
separate from email tracking freshness.

## People table layout

Migrations `031_people_column_layout.sql` and `032_people_email_after_tags.sql`
change display metadata only. People starts with Full Name, Company, Job Title,
Purpose, Tags, Email Address, Phone Number and LinkedIn URL; First Name and Last Name remain at the end. People no
longer reorders these columns by fill rate. Company ordering is unchanged.
Tags uses the existing editable badge renderer; JSON editor values are decoded
into PostgreSQL arrays on create/update. Saved filters, contact values,
subscriptions and campaign history are unchanged.

## Platform account identity links

Migration `041_crm_platform_accounts.sql` adds `crm_platform_accounts`, keyed by
Supabase `auth.users.id` (UUID), without importing or changing CRM people.
`person_id` is a nullable **text** foreign key to the existing `crm_people.id`,
with `ON DELETE SET NULL`; platform `account_id` is a UUID. Role, account status,
email, auth creation and last sign-in are a private CRM-side snapshot, not
PostHog person properties. `linked_at` tracks the link decision and `updated_at`
changes only when stored values change.

Take a current `pg_dump -Fc denchclaw` backup before applying this migration in
a transaction. The standard schema runner discovers it automatically. Run
`python3 scripts/rebattery/platform_account_sync.py --dry-run` for aggregate
counts, then `--apply` only when ready to update local link records. The default
is dry-run. Supabase reads use the approved
`/root/.hermes/workspace/secrets/dench-platform-admin.env`; production requests
are GET-only and must verify the production project host. The script reads every
auth-user and PostgREST page before local writes and commits atomically.

Email matching trims and lowercases only; dots and plus-tags are significant.
Duplicate CRM emails and unmatched auth users remain unlinked with
`needs_review`; no CRM people are created. Multiple platform account memberships
are not arbitrarily collapsed into a role: the account fields stay null and
the row requires review. `unknown` role counts include accounts without a unique
platform account. Match counts describe email-match candidates, not subsequent
manual overrides. Sync preserves manual links and confirmed/rejected decisions
while refreshing platform metadata. Identical syncs do not change timestamps.

`lib/crm-postgres/platform-accounts.ts` supports authenticated callers listing,
reading, reviewing and manually linking/unlinking identities. Unlinking records
a protected rejection, so a later email match cannot silently restore it.
Never expose these email-bearing records publicly or send their emails to
PostHog. Tests use temporary tables only; run
`PLATFORM_ACCOUNT_TEST_DSN='dbname=denchclaw' python3 -m pytest scripts/rebattery/test_platform_account_sync.py`
and the focused Vitest file `lib/crm-postgres/platform-accounts.test.ts`.

Hourly service/timer templates live in `scripts/rebattery/systemd/`. They are
**not installed or enabled**. Review the checkout and Python interpreter paths
(including `psycopg2` availability) before separately authorizing installation.
The timer invokes `--apply`; its journal contains aggregate counts only.

## Bulk-trade demand shortlist (16 October 2026)

The Bulk Trades workspace has four tabs: **Today | Trades | Demand | Supply**.
Today is the default work queue: overdue next steps, qualifying questions not
sent, Inbox proposals, trades missing a seller or buyer, and demand missing
information. Each section opens the relevant record or Inbox; longer lists
expand beyond the first five items. Trades is the operational board; Demand
is the buyer-ask shortlist and activity workspace; Supply is the unified
available-inventory feed. The **Inbox** button opens a right-hand review drawer,
not another tab. Accept or reject new demand, supply and trade candidates there,
or apply proposed updates to existing trades. Accepted demand refreshes both
the Demand workspace and Today's demand queues.

Migrations `046`–`048` support trades from either side: `origin` records whether
the opportunity started with supply or demand, not whether both sides are now
present. Seller identity/name and buyer records are tracked independently;
board cards expose missing sides. Seller references use `company:`, `supply:`
or `stock:` namespaces, with evidence retained for seller attribution.

The unified supply feed combines open supplier batches, eligible sell-side
trades and live published auctions, plus available stock grouped by make/model
family. Promoted batches are represented by their trades rather than duplicated.
Sold/unavailable stock and ended auctions are excluded; stock is verified only
when every row in its group is supplier-confirmed. Closed supplier-batch history
remains available separately from the available feed.

Demand and supplier-batch detail sheets show **Company context** notes for the
linked company. These dated, source-attributed notes live in
`crm_company_context_notes`, separate from mutable buyer profiles; they describe
the company, not a new actionable ask. Demand's **Missing to move this** section
surfaces missing price, quantity, request timeline, unsent qualification question
or eligible supply match. These are action gaps, not automatic closures.

Migration `049` categorises context as `ask`, `bid`, `offer_reply`, `project`,
`preference`, `trading_style`, `past_deal` or `note`, with optional evidence URLs.
All surfaces show muted category chips and newest-first dates; company profiles
also filter by category. These internal notes can contain commercial terms and
must not be forwarded as buyer-facing copy.

The October audit repair scripts (`restore_demand_context.py`, `restore_demand_history.py`, `demand_recategorize.py`) were one-off tools and have been removed; they remain in git history.

Migration `044` separates current sourcing work from buyer discovery. **Demand**
is a buyer's own dated, actionable request or standing ask with an identified
buyer, product family and quantity. **Qualifying** holds a specific need that
still needs a quantity, identity or reconfirmation; keep its next question
explicit. **Buyer profiles** describe general buying capabilities or buy-boxes,
with `researched` or `stated` basis, evidence and a profile date on the company.
They suggest whom to introduce, not what to source today. **Lot interest** is a
reply or bid to stock we offered and belongs to that lot's buyer/bid records,
not to standalone demand. Recycling intake remains a separate pipeline.

The shortlist orders open rows before qualifying rows and closed history.
Within each status, score bands come first, then manual **Priority** within
the band, then score. Priority never lifts a cold opportunity above a hotter
band. Fee is quantity × unit price × 10%. Buyer-stated prices count in full;
our estimates count at half weight:

```
asked_on = latest(observed_on, confirmed_on)
freshness = 0.5 ^ (days_since_asked_on / 30)
expected_fee = fee_eur × price_weight × close_chance × freshness
score = min(100, round(25 × log10(1 + expected_fee)))
```

`price_weight` is 1 for `buyer`, otherwise 0.5. Reputation priors are `paid`
0.60, `active` 0.35, `email` 0.20, `inbound` 0.10 and `anon` 0.03. Bands are
Hot ≥80, Warm 60–79, Low 40–59 and Cold <40. Missing fee inputs produce no
score ("Needs quantity"), not zero. Reconfirmation resets freshness.
Stock availability and product-family grouping are context, not score factors.

Inbox/call demand extraction is proposal-only: approval is required before a
new ask becomes demand. Offer replies route to the existing lot rather than
creating a new ask; evidence must come from the new message, not quoted history.
Resolve the buyer identity and deduplicate by entity plus normalized product
family across open and qualifying rows, not by wording.

Standing asks become qualifying at 60 days ("Still buying?"). Entry into
qualification stamps `qualify_entered_on` across UI, proposal and import writers.
`qualify_asked_on` is the date the question was actually sent: null means not
sent, so the row stays qualifying and the lifecycle reports `question_not_sent`.
Only 21 days after sending, without reconfirmation, does a qualifying standing
ask move to the company profile or a qualifying request expire. Reconfirmation
must be dated strictly after the question was sent; same-day creation or
acceptance is not a response. Old buyer observations never age a qualifying row.
In the Demand detail panel, **Qualify** saves the next question without starting
the response clock. Use **Question sent today** only after actually sending it;
this sets `qualify_asked_on`. **Send again** resets that date and the 21-day
response window. **Still wanted** records a new confirmation; it only counts
as a response when dated after `qualify_asked_on`.

Open requests still expire after
`needed_by`, or after 90 days without a deadline, using their latest observation
or confirmation. Closure is an explicit lifecycle transition, not score-based.

The Demand list shows activity counts and opens a detail panel for the selected
ask. Its activity workspace (`045_demand_activity.sql`) supports `note`,
`research`, `outreach`, `call`, `quote`, `supply` and `status` entries, with a
required title, optional body and timestamped history. Under **Details / link**,
link a URL, lot, supply record or stock-item URL. Lot and supply links navigate
to their existing CRM views; web links open in a separate tab. Suggested supply
can be pinned as a linked `supply` activity without creating a trade.
Status transitions are logged atomically by a database trigger, including
script-originated changes. **Still wanted** also appears in activity. The API
is `/api/bulk-trades/demand/[demandId]/activity`; deleting an entry is scoped to
both its demand and activity IDs.

Saved searches feed company profiles, never open demand. Sourcing requests
enter as qualifying demand. Surveys are profile evidence unless they state
both quantity and timing; specific incomplete needs belong in qualification.
The scheduled importer and inbox checker use the detached
`/root/denchclaw/scripts-live` worktree. `saved_search_import.py` defaults to a
rollback-only dry run; `--apply` is reserved for the scheduled gate or an
explicitly authorized import.

### Demand History restoration (18 October 2026)

`053_demand_history.sql` adds `offer_reply` and `research_profile` categories
and records category-only changes in status activity without reopening a row.
History includes every closed category. All counts every closed row but hides
Research profile rows until that category is selected. Category changes are
available in the detail header; Reopen remains an explicit separate action.
Closed rows have no qualification gaps, score, expected fee or supply suggestions.
The survey importer refreshes unfinished answers only while open or qualifying;
closed History evidence cannot be overwritten by a later survey refresh.

## Captured WhatsApp context

Person and company profiles have a WhatsApp tab beside email history. Group
discovery uses active identity links to observed members and shows the whole
group as shared context, not as private correspondence or trade attribution.
`/whatsapp/threads/[id]` is read only and uses canonical local database IDs.
It shows sender uncertainty, replies, edit/delete markers, undownloaded media,
capture-time fallback and incomplete history. Imported capture status is a
saved observation, not a live provider check.

`/whatsapp/identities` lists unmatched identities first. Confirm an existing
person or search for another; unlink a wrong decision before reassignment.
The decision ledger retains its actor and validity interval. No contact is
created and no CRM phone field is changed. Shared/company-only links supported
by the identity API follow the same rules as the local importer.

Bulk Trades show only explicitly linked live evidence. Conversation and message
trade-link controls write many-to-many `whatsapp_live_thread` and
`whatsapp_live_message` references, never copies of messages or legacy export
IDs. Membership alone never creates a trade link. All WhatsApp API entry points
use `canReadWhatsapp`, the single future role-flag boundary; authenticated
operators currently all have access. These routes never send or fetch media.

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

The Hermes adapter emits AI SDK `UIMessageChunk` events. An error chunk contains
`type: "error"` and `errorText`, not an HTTP `status` property. Preserve the
upstream failure text without turning it into a client schema-validation error.
The adapter regressions parse the stream through `DefaultChatTransport`, the
same strict validator used by the chat client.

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
`crm_campaign_send_links.first_clicked_at` for the matching listing. The provider's
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

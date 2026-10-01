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

Listing count links open square right-side people sheets, filtered by destination
and email/browser/submission source, with local identity search and 25-row
pagination. Listing and general-destination email evidence comes from the
ordinary CRM detail ledger and remains available if PostHog or its private
manifest fails. Submission sheets use the selected kind's latest timestamp.
Original snapshot totals are never replaced with retained-cohort counts.
Unknown attribution, provider failure and recorded zero remain distinct.

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

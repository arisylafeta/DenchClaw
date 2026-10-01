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

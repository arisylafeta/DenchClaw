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

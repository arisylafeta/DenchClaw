# ReBattery CRM authentication deployment

The production CRM has exactly two invite-only application users. Bootstrap requires a different runtime password for each account:

- `CRM_BOOTSTRAP_PASSWORD_ARI` for `ari@rebattery.io`
- `CRM_BOOTSTRAP_PASSWORD_ALEX` for `alex@rebattery.io`

Both variables are required, must contain 12 to 1024 characters, and must not have the same value. Inject them from the approved runtime secret source immediately before running `pnpm --dir apps/web db:auth:bootstrap`. Never put their values in Git, deployment logs, shell transcripts, or chat.

The bootstrap hashes each password independently and only writes the matching hash to its allowlisted account. It also reactivates those accounts, clears login lockouts, reconciles actionable Work Task assignments, and removes assignments from Done or Retired tasks.

nginx Basic Auth remains an outer deployment gate until both Ari and Alex pass application sign-in and cross-user isolation QA. Do not remove or bypass that gate as part of database bootstrap.

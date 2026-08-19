# Dench admin message monitoring

The protected **Admin → Message monitoring** page is a read-only view over the
marketplace `public.conversations` and `public.conversation_messages` tables.
It is available only after the existing Dench CRM session middleware accepts an
authorised admin session.

Use the single search field to match message text, conversation IDs, account
names or IDs, listing titles/references/IDs, and sender names or email. Date
and moderation-status filters remain available; moderation source and reason
are shown as audit metadata rather than separate filters. Results are loaded
newest first (with message ID as a deterministic tie-breaker) in bounded
server-side pages. Selecting a row opens a protected detail view with the full
body, moderation audit fields, related listing/account links, attachment
metadata, and a bounded nearby thread context.

`delivered`, `rejected`, and `pending` are separate states. A delivered message
with `fail-open` and a failure code (especially `configuration`) means the
moderation provider was bypassed; it must not be read as an ordinary
model-reviewed delivery. The page does not approve, delete, re-run, or change
message status.

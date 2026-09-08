# Battery requests

**Admin → Battery requests** opens `/platform-admin/battery-requests` in a
full-width DenchClaw workspace tab. It reads only `public.battery_requests`
through the existing server-only platform-admin Supabase client.

The page lists contact email, intent, saved battery description and creation
time in UTC. Expandable rows show the complete `request_json` as readable fields,
preserving unknown values and missing details. Submitted strings are rendered
as text, never HTML or executable links. Runtime, trace and idempotency metadata
is excluded from the response.

Reads require an authenticated, allowlisted CRM user in addition to existing
session middleware. Results are not cached. Email substring search escapes LIKE
metacharacters. Pages contain at most 25 rows, ordered by creation time and ID
descending. Stale page numbers return the last page when a count is available;
a PostgREST range rejection restarts at the first page.

No Supabase writes, synchronization, CRM matching, enrichment or email delivery
are performed. Requests are not combined with offers, invitations or legacy
listings. No workflow status is invented. No schema migration or new environment
variable is required.

# Battery inquiries

**Admin → Battery inquiries** opens `/platform-admin/battery-requests` in a
full-width DenchClaw workspace tab. It reads only `public.battery_requests`
and the associated user/assistant messages from `public.jules_messages` through
the existing server-only platform-admin Supabase client.

The page lists contact email, intent, saved battery description and creation
time in UTC. Expandable rows show the complete `request_json` as readable fields,
preserving unknown values and missing details. A **View chat** artifact opens the
inquiry's ordered Joules transcript in a right-side sheet. System-role messages
and runtime metadata are excluded. Submitted strings are rendered as text, never
HTML or executable links. Trace and idempotency metadata is also excluded.

Reads require an authenticated, allowlisted CRM user in addition to existing
session middleware. Results are not cached. Email substring search escapes LIKE
metacharacters. Pages contain at most 25 rows, ordered by creation time and ID
descending. A chat is loaded on demand in a bounded query and ordered by
sequence. Stale page numbers return the last page when a count is available; a
PostgREST range rejection restarts at the first page.

No Supabase writes, synchronization, CRM matching, enrichment or email delivery
are performed. Inquiries are not combined with offers, invitations or legacy
listings. No workflow status is invented. No schema migration or new environment
variable is required.

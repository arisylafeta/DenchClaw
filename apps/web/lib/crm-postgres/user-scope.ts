/** CRM objects whose rows contain mailbox- or assignee-private data. */
const ISOLATED_OBJECT_NAMES = new Set([
  "email_thread",
  "email_message",
  "interaction",
  "work_task",
]);

export function requiresIsolatedPostgres(objectName: string): boolean {
  return ISOLATED_OBJECT_NAMES.has(objectName.trim().toLowerCase());
}

export function isolatedBackendResponse(): Response {
  return Response.json(
    { error: "Per-user CRM data requires the Postgres backend" },
    { status: 503 },
  );
}

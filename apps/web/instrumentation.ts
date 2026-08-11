export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTerminalServer } = await import("./lib/terminal-server");
    startTerminalServer(Number(process.env.TERMINAL_WS_PORT) || 3101);

    const { startChatAgentGc } = await import("./lib/chat-agent-registry");
    startChatAgentGc();

    // Apply the latest schema migrations on startup so workspaces that
    // were init'd before a column/field/object was added still get it
    // without forcing the user to re-init. Idempotent: ALTER TABLE … IF
    // NOT EXISTS, INSERT … OR IGNORE etc. inside `ensureLatestSchema`.
    // Without this, hidden_in_sidebar (and Sender Type, etc.) wouldn't
    // exist on the DB until the user manually triggered onboarding.
    if (process.env.CRM_DB_BACKEND !== "postgres") {
      try {
        const { ensureLatestSchema } = await import("./lib/workspace-schema-migrations");
        await ensureLatestSchema();
      } catch (err) {
        // Non-fatal — the workspace runs fine without the new fields, the
        // user just won't see CRM-only objects hidden from the tree until
        // the migration is re-attempted.
        console.error("[instrumentation] ensureLatestSchema failed:", err);
      }
    }

  }
}

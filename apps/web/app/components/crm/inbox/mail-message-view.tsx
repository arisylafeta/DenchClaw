"use client";

import { Mail } from "lucide-react";
import { useMailMessage } from "../../mail-message-card";
import { Loading } from "../../ui/shimmer";
import { ThreadMessages } from "./thread-messages";
import { MessageBody } from "./message-body";

/** Content-tab view of one logged email: its whole conversation, read-only. Opens even when the CRM inbox hides the thread. */
export function MailMessageView({ messageId }: { messageId: string }) {
  const load = useMailMessage(messageId);
  if (load.status === "loading") {return <Loading label="Loading email…" variant="detail" />;}
  if (load.status === "error") {return <div role="alert" className="p-6 text-[13px]" style={{ color: "var(--color-error)" }}>{load.message}</div>;}
  const m = load.message;
  return (
    <section aria-label="Email" className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-surface)", color: "var(--color-text)" }}>
      <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b px-4 py-3 sm:px-6" style={{ borderColor: "var(--color-border)" }}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}>
          <Mail className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold sm:text-base">{m.subject || "(no subject)"}</h2>
          <p className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>{m.direction === "inbound" ? `From ${m.from_email ?? "unknown"}` : `To ${m.to_emails.join(", ") || "no recipient"}`}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {m.thread_id
          ? <ThreadMessages key={m.id} threadId={m.thread_id} initialMessageId={m.id} crmOnly={false} showReply={false} />
          : <div className="p-6"><MessageBody body={m.body_text} html={m.body_html} preview={m.body_preview} /></div>}
      </div>
    </section>
  );
}

"use client";

import type { CampaignRecipient } from "@/lib/crm-postgres/registered-entry-detail";
import { buildEntryLink } from "@/lib/workspace-links";

export function CampaignDetailPreview({
  recipients,
  onNavigateEntry,
}: {
  recipients: CampaignRecipient[];
  onNavigateEntry?: (objectName: string, entryId: string) => void;
}) {
  return (
    <section aria-label="Invited people" className="border-t px-5 py-5" style={{ borderColor: "var(--color-border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
        Invited people ({recipients.length})
      </h3>
      {recipients.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--color-text-muted)" }}>No recipient-level sends recorded for this campaign.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {recipients.map((recipient) => {
            const delivery = recipient.bounced_at ? "Bounced"
              : recipient.delivered_at ? "Delivered"
              : recipient.accepted_at ? "Postmark accepted · delivery unconfirmed"
              : recipient.state === "failed" ? "Failed"
              : recipient.state === "unknown" || recipient.state === "sending" ? "Send outcome unconfirmed"
              : "Not sent";
            return (
              <li key={recipient.person_id} className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
                <a
                  href={buildEntryLink("people", recipient.person_id)}
                  onClick={onNavigateEntry ? (event) => {
                    event.preventDefault();
                    onNavigateEntry("people", recipient.person_id);
                  } : undefined}
                  className="text-sm font-medium underline underline-offset-2"
                  style={{ color: "var(--color-text)" }}
                >{recipient.person_name || recipient.recipient_email}</a>
                <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>{recipient.recipient_email}</div>
                <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {delivery}
                  {recipient.provider_opened_at && " · Provider open recorded"}
                  {recipient.provider_link_clicked_at && " · Auction email link clicked (site visit unverified)"}
                </div>
                {recipient.clicked_ctas && recipient.clicked_ctas.length > 0 && (
                  <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Clicked: {recipient.clicked_ctas.map((cta) => cta.cta_key).join(", ")}
                  </div>
                )}
                {recipient.provider_message_id && (
                  <div className="mt-1 break-all text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                    Postmark ID: {recipient.provider_message_id}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

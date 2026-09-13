"use client";

import type { RegisteredEntryDetail } from "@/lib/crm-postgres/registered-entry-detail";
import { displayObjectName } from "@/lib/object-display-name";

type Props = {
  detail: Extract<RegisteredEntryDetail, { kind: "bulk_trade" }>;
  onNavigateEntry?: (objectName: string, entryId: string, relatedObjectId?: string) => void;
};

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function shortDate(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? raw
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function sourceBadge(source: string) {
  const colors: Record<string, { background: string; color: string }> = {
    WhatsApp: { background: "rgba(34, 197, 94, 0.12)", color: "#16a34a" },
    Gmail: { background: "rgba(239, 68, 68, 0.1)", color: "#dc2626" },
    CRM: { background: "var(--color-surface-hover)", color: "var(--color-text)" },
  };
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={colors[source]}>
      {source}
    </span>
  );
}

function relationshipLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function BulkTradeDetailPreview({ detail, onNavigateEntry }: Props) {
  const buyers = detail.parties.filter((party) => party.role === "buyer");
  const otherParties = detail.parties.filter((party) => party.role !== "buyer");
  const evidenceCount = detail.whatsappMessages.length + detail.gmailThreads.length + detail.opportunities.length;

  return (
    <section className="space-y-5 px-5 pb-6" data-testid="bulk-trade-detail-preview">
      <div className="rounded-xl p-4" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--color-text)" }}>
              Evidence workspace preview
            </div>
            <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>
              Read-only evidence. Marketplace offers and deals remain authoritative.
            </p>
          </div>
          <span className="rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}>
            {evidenceCount} sources
          </span>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2">
          {[
            ["Buyers", buyers.length],
            ["WhatsApp", detail.whatsappMessages.length],
            ["Email", detail.gmailThreads.length],
            ["CRM", detail.opportunities.length],
          ].map(([label, count]) => (
            <div key={String(label)} className="rounded-lg px-2 py-2 text-center" style={{ background: "var(--color-bg)" }}>
              <div className="text-base font-semibold" style={{ color: "var(--color-text)" }}>{count}</div>
              <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>Potential buyers</h3>
          <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>{buyers.length}</span>
        </div>
        {buyers.length === 0 ? (
          <div className="rounded-xl border border-dashed p-4 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
            No named buyer is linked yet.
          </div>
        ) : (
          <div className="space-y-2">
            {buyers.map((buyer) => (
              <button
                type="button"
                key={buyer.id}
                onClick={() => buyer.company_id && onNavigateEntry?.("company", buyer.company_id)}
                disabled={!buyer.company_id}
                className="w-full rounded-xl p-3 text-left transition-colors enabled:hover:bg-[var(--color-surface-hover)]"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" style={{ color: "var(--color-text)" }}>{buyer.display_name}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                      {[buyer.channel, buyer.observed_outcome].filter(Boolean).join(" · ") || "Buyer relationship"}
                    </div>
                  </div>
                  {buyer.latest_evidence_at && <span className="flex-shrink-0 text-[10px]" style={{ color: "var(--color-text-muted)" }}>{shortDate(buyer.latest_evidence_at)}</span>}
                </div>
                {buyer.notes && <p className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>{buyer.notes}</p>}
              </button>
            ))}
          </div>
        )}
      </div>

      {otherParties.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>Supply side</h3>
          <div className="flex flex-wrap gap-2">
            {otherParties.map((party) => (
              <span key={party.id} className="rounded-full px-2.5 py-1 text-xs" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}>
                {party.display_name} · {party.role}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>Evidence timeline</h3>
        <div className="space-y-3">
          {detail.whatsappMessages.map((item) => (
            <article key={`wa-${item.id}`} className="rounded-xl p-3" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">{sourceBadge("WhatsApp")}<span className="truncate text-xs font-medium" style={{ color: "var(--color-text)" }}>{item.sender || item.conversation}</span></div>
                <span className="flex-shrink-0 text-[10px]" style={{ color: "var(--color-text-muted)" }}>{shortDate(item.occurred_at)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-5" style={{ color: "var(--color-text)" }}>{item.body}</p>
              <div className="mt-2 text-[10px] capitalize" style={{ color: "var(--color-text-muted)" }}>{relationshipLabel(item.relationship)}</div>
            </article>
          ))}

          {detail.gmailThreads.map((thread) => (
            <article key={`gmail-${thread.id}`} className="rounded-xl p-3" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">{sourceBadge("Gmail")}<span className="truncate text-xs font-medium" style={{ color: "var(--color-text)" }}>{thread.subject || "Email thread"}</span></div>
                <span className="flex-shrink-0 text-[10px]" style={{ color: "var(--color-text-muted)" }}>{shortDate(thread.last_message_at)}</span>
              </div>
              <div className="mt-2 space-y-2">
                {!thread.accessible && (
                  <div className="rounded-lg px-3 py-2 text-xs leading-5" style={{ background: "var(--color-bg)", color: "var(--color-text-muted)" }}>
                    Linked email is not assigned to this mailbox yet.
                  </div>
                )}
                {thread.messages.map((message) => (
                  <div key={message.id} className="rounded-lg px-3 py-2" style={{ background: "var(--color-bg)" }}>
                    <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{message.from_email || "Email"}</div>
                    <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text)" }}>{message.body_preview || "No preview stored."}</p>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[10px] capitalize" style={{ color: "var(--color-text-muted)" }}>{relationshipLabel(thread.relationship)}</div>
            </article>
          ))}

          {detail.opportunities.map((opportunity) => (
            <article key={`crm-${opportunity.id}`} className="rounded-xl p-3" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">{sourceBadge("CRM")}<span className="truncate text-xs font-medium" style={{ color: "var(--color-text)" }}>{opportunity.title || "CRM opportunity"}</span></div>
                <span className="flex-shrink-0 text-[10px]" style={{ color: "var(--color-text-muted)" }}>{shortDate(opportunity.updated_at)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                {[opportunity.opportunity_type && displayObjectName(opportunity.opportunity_type), opportunity.status, opportunity.quantity && `${opportunity.quantity} units`, opportunity.location_country].filter(Boolean).map((value) => (
                  <span key={String(value)} className="rounded-full px-2 py-0.5" style={{ background: "var(--color-bg)" }}>{value}</span>
                ))}
              </div>
              <div className="mt-2 text-[10px] capitalize" style={{ color: "var(--color-text-muted)" }}>{relationshipLabel(opportunity.relationship)}</div>
              {opportunity.evidence_note && <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>{opportunity.evidence_note}</p>}
            </article>
          ))}

          {evidenceCount === 0 && (
            <div className="rounded-xl border border-dashed p-4 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>No evidence is linked.</div>
          )}
        </div>
      </div>
    </section>
  );
}

"use client";

import { ExternalLink, Mail } from "lucide-react";
import { buildEntryLink } from "@/lib/workspace-links";
import { CompanyFavicon } from "../crm/company-favicon";
import { PersonAvatar } from "../crm/person-avatar";

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);
const domainOf = (email: string | null) => {
  const domain = email?.split("@")[1]?.toLowerCase();
  return domain && !FREE_MAIL.has(domain) ? domain : null;
};

const actionClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-none border px-2.5 text-[12px] font-medium hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]";
const actionStyle = { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" };

export type PartyCardProps = {
  /** "Buyer" or "Seller". */
  role: string;
  /** The company, as written on the listing. */
  name: string;
  companyId: string | null;
  personId: string | null;
  /** The person we deal with. */
  contact: string | null;
  email: string | null;
  /** Small facts in one line under the name, e.g. A-tier, In conversation, Owner Alex. */
  chips?: string[];
  /** Figures in one line, e.g. Last heard 29 days ago. */
  stats?: { label: string; value: string }[];
  notes?: { label: string; value: React.ReactNode; bad?: boolean }[];
  related?: { label: string; items: { id: string; label: string; onOpen?: () => void }[] };
};

/**
 * The person on the other side of a listing, laid out like a CRM person header: avatar, name, email and company,
 * actions on the right, then what we know about them. Full width.
 */
export function PartyCard({ role, name, companyId, personId, contact, email, chips = [], stats = [], notes = [], related }: PartyCardProps) {
  const company = companyId ? buildEntryLink("company", companyId) : null;
  const person = personId ? buildEntryLink("people", personId) : null;
  const crm = person ?? company;
  const shown = contact?.trim() || name;
  const hasMore = chips.length > 0 || stats.length > 0 || notes.length > 0 || (related?.items.length ?? 0) > 0;
  return (
    <section aria-label={`${role} card`} className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <PersonAvatar name={shown} seed={email ?? personId ?? name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.08em]" style={{ color: "var(--bt-muted)" }}>{role}</div>
          <div className="text-[15px] font-semibold leading-tight">{crm ? <a href={crm} className="hover:underline">{shown}</a> : shown}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: "var(--bt-text-2)" }}>
            {email && <a href={`mailto:${email}`} className="truncate hover:underline">{email}</a>}
            {contact && name !== contact && (
              <span className="inline-flex items-center gap-1.5">
                <CompanyFavicon domain={domainOf(email)} name={name} size="sm" />
                {company ? <a href={company} className="hover:underline">{name}</a> : name}
              </span>
            )}
            {chips.map((chip) => <span key={chip} className="border px-1.5 py-px" style={{ borderColor: "var(--bt-border)" }}>{chip}</span>)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {email && <a href={`mailto:${email}`} className={actionClass} style={actionStyle}><Mail size={14} aria-hidden="true" /> Compose email</a>}
          {crm && <a href={crm} className={actionClass} style={actionStyle}><ExternalLink size={14} aria-hidden="true" /> Open in CRM</a>}
        </div>
      </div>
      {hasMore && (
        <div className="flex flex-col gap-2 border-t px-4 py-3 text-[13px]" style={{ borderColor: "var(--bt-divider)" }}>
          {stats.length > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {stats.map((stat) => <span key={stat.label}><span style={{ color: "var(--bt-muted)" }}>{stat.label} </span>{stat.value}</span>)}
            </div>
          )}
          {notes.map((note) => (
            <p key={note.label} style={note.bad ? { color: "var(--bt-red)" } : undefined}>
              <span style={{ color: note.bad ? undefined : "var(--bt-muted)" }}>{note.label} </span>{note.value}
            </p>
          ))}
          {related && related.items.length > 0 && (
            <p>
              <span style={{ color: "var(--bt-muted)" }}>{related.label} </span>
              {related.items.map((item, index) => (
                <span key={item.id}>{index > 0 && ", "}
                  {item.onOpen ? <button type="button" className="underline" onClick={item.onOpen}>{item.label}</button> : item.label}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      {!companyId && <p className="border-t px-4 py-2 text-[12px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>Not linked to a CRM company yet.</p>}
    </section>
  );
}

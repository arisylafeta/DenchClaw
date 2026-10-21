"use client";

import { ExternalLink, Mail } from "lucide-react";
import { buildEntryLink } from "@/lib/workspace-links";
import { CompanyFavicon } from "../crm/company-favicon";
import { Sh, BusyRegion } from "./bt-shimmer";
import { avatarFromName } from "@/lib/avatar-initials";
import { PersonAvatar } from "../crm/person-avatar";

const actionClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-none border px-2.5 text-[12px] font-medium hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]";
const actionStyle = { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" };

export type PartyPerson = {
  name: string | null; email: string | null; job_title: string | null; phone: string | null; linkedin_url: string | null;
  company_name: string | null; company_domain: string | null; website: string | null;
};

export type PartyCardProps = {
  /** "Buyer" or "Seller". */
  role: string;
  loading?: boolean;
  /** The company, as written on the listing. */
  name: string;
  companyId: string | null;
  personId: string | null;
  /** What the CRM knows about the person; the listing's contact and email stand in until it loads. */
  person: PartyPerson | null;
  contact: string | null;
  email: string | null;
  /** The few facts that matter, shown as small tiles: Stage, Owner, Last heard. */
  glance?: { label: string; value: string }[];
  notes?: { label: string; value: React.ReactNode; bad?: boolean }[];
  related?: { label: string; items: { id: string; label: string; onOpen?: () => void }[] };
  /** Extra sections that belong to the person, shown at the foot of the card (their email and WhatsApp conversations). */
  children?: React.ReactNode;
};

/** A compact CRM person header: avatar, name, email, role and company, actions, then what matters at a glance. */
export function PartyCard({ role, name, companyId, personId, person, contact, email, glance = [], notes = [], related, loading, children }: PartyCardProps) {
  if (loading !== undefined) glance = ["Stage", "Owner", "Last heard"].map((label) => glance.find((item) => item.label === label) ?? { label, value: "Not recorded" });
  if (loading !== undefined) notes = [
    ...["Usually buys", "Notes"].map((label) => notes.find((note) => note.label === label) ?? { label, value: "Not recorded" }),
    ...notes.filter((note) => note.label !== "Usually buys" && note.label !== "Notes"),
  ];
  const theme = avatarFromName(name, email ?? undefined);
  const company = companyId ? buildEntryLink("company", companyId) : null;
  const profile = personId ? buildEntryLink("people", personId) : company;
  const shown = person?.name?.trim() || contact?.trim() || name;
  const mail = person?.email ?? email;
  const companyName = person?.company_name ?? name;
  const website = person?.website?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const askRows = related && related.items.length > 0;
  return (
    <BusyRegion busy={!!loading} label="Loading buyer details">
    <section aria-label={`${role} card`} className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex flex-wrap items-start gap-3 px-4 pb-3 pt-4">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full" style={{ background: theme.background, color: theme.foreground }}>
          {loading ? <Sh on chars={2} /> : <PersonAvatar name={shown} seed={mail ?? personId ?? name} size="lg" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[18px] font-semibold leading-tight tracking-[-0.01em]">
            <Sh on={loading} chars={18}>{profile ? <a href={profile} className="hover:underline">{shown}</a> : shown}</Sh>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: "var(--bt-text-2)" }}>
            {(loading || mail) && <Sh on={loading} chars={23}><a href={`mailto:${mail}`} className="truncate hover:underline">{mail}</a></Sh>}
            {person?.job_title && <span>{person.job_title}</span>}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center"><Sh on={loading} chars={1}><CompanyFavicon domain={person?.company_domain} name={companyName} size="sm" /></Sh></span>
              <Sh on={loading} chars={15}>{company ? <a href={company} className="hover:underline">{companyName}</a> : companyName}</Sh>
            </span>
            {person?.phone && <a href={`tel:${person.phone}`} className="hover:underline">{person.phone}</a>}
            {website && <a href={person!.website!} target="_blank" rel="noreferrer" className="hover:underline">{website}</a>}
            {person?.linkedin_url && <a href={person.linkedin_url} target="_blank" rel="noreferrer" className="hover:underline">LinkedIn</a>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading && <button type="button" disabled className={actionClass} style={actionStyle}><Mail size={14} aria-hidden="true" /> Compose email</button>}
          {!loading && mail && <a href={`mailto:${mail}`} className={actionClass} style={actionStyle}><Mail size={14} aria-hidden="true" /> Compose email</a>}
          {profile && <a href={profile} className={actionClass} style={actionStyle}><ExternalLink size={14} aria-hidden="true" /> Open in CRM</a>}
        </div>
      </div>
      {glance.length > 0 && (
        <div className="grid gap-2 px-4 pb-3" style={{ gridTemplateColumns: `repeat(${Math.min(glance.length, 4)}, minmax(0, 1fr))` }}>
          {glance.map((item) => (
            <div key={item.label} className="border px-3 py-2" style={{ borderColor: "var(--bt-border)" }}>
              <div className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--bt-muted)" }}>{item.label}</div>
              <div className="mt-0.5 truncate text-[14px] font-semibold"><Sh on={loading} chars={10}>{item.value}</Sh></div>
            </div>
          ))}
        </div>
      )}
      {(notes.length > 0 || askRows) && (
        <div className="mx-4 mb-4 flex flex-col gap-2 border px-3 py-2.5 text-[13px] leading-snug" style={{ borderColor: "var(--bt-border)" }}>
          {notes.map((note) => (
            <p key={note.label} style={note.bad ? { color: "var(--bt-red)" } : undefined}>
              <span className="font-semibold">{note.label} </span><Sh on={loading} chars={28}>{note.value}</Sh>
            </p>
          ))}
          {askRows && (
            <p>
              <span className="font-semibold">{related!.label} </span>
              {related!.items.map((item, index) => (
                <span key={item.id}>{index > 0 && ", "}
                  {item.onOpen ? <button type="button" className="underline" onClick={item.onOpen}>{item.label}</button> : item.label}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      {children && <div className="mx-4 mb-4 flex flex-col gap-2">{children}</div>}
      {!companyId && <p className="border-t px-4 py-2 text-[12px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>Not linked to a CRM company yet.</p>}
    </section>
    </BusyRegion>
  );
}

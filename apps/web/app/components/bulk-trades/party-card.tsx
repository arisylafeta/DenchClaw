"use client";

import { buildEntryLink } from "@/lib/workspace-links";
import css from "./party-card.module.css";

const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
};
/** A stable pastel per name, so the same company always has the same avatar. */
const tint = (name: string) => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 88%)`;
};

export type PartyCardProps = {
  /** "Buyer" or "Seller". */
  role: string;
  name: string;
  companyId: string | null;
  personId: string | null;
  contact: string | null;
  email: string | null;
  chips?: { label: string; tone?: "tier" }[];
  rows?: { label: string; value: React.ReactNode; bad?: boolean }[];
};

/** Who is on the other side of a listing: avatar, company, their stage, the contact and a way into the CRM. */
export function PartyCard({ role, name, companyId, personId, contact, email, chips = [], rows = [] }: PartyCardProps) {
  const profile = companyId ? buildEntryLink("company", companyId) : null;
  const person = personId ? buildEntryLink("people", personId) : null;
  return (
    <section className={css.card} aria-label={`${role} card`}>
      <div className={css.head}>
        <span className={css.avatar} style={{ background: tint(name) }} aria-hidden="true">{initials(name)}</span>
        <div className="min-w-0">
          <div className={css.role}>{role}</div>
          <div className={css.name}>{profile ? <a href={profile}>{name}</a> : name}</div>
        </div>
      </div>
      {chips.length > 0 && (
        <div className={css.chips} style={{ marginTop: -6 }}>
          {chips.map((chip) => <span key={chip.label} className={css.chip} data-tone={chip.tone}>{chip.label}</span>)}
        </div>
      )}
      {(contact || email) && (
        <div className={css.contact}>
          {contact && <strong>{person ? <a href={person} style={{ color: "inherit", textDecoration: "none" }}>{contact}</a> : contact}</strong>}
          {email && <a href={`mailto:${email}`}>{email}</a>}
        </div>
      )}
      {rows.length > 0 && (
        <dl className={css.rows}>
          {rows.map((row) => <div key={row.label}><dt>{row.label} </dt><dd className={row.bad ? css.bad : undefined}>{row.value}</dd></div>)}
        </dl>
      )}
      {!companyId && <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Not linked to a CRM company yet.</p>}
      {profile && <a className={css.link} href={profile}>Open in CRM</a>}
    </section>
  );
}

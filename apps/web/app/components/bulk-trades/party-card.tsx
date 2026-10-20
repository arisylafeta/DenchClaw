"use client";

import { ExternalLink, Mail, User } from "lucide-react";
import { buildEntryLink } from "@/lib/workspace-links";
import css from "./party-card.module.css";

const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
};
/** A stable hue per name, so the same company always has the same colours. */
const hue = (name: string) => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
};

export type PartyChip = { label: string; tone?: "tier" | "stage" | "owner" };
export type PartyCardProps = {
  /** "Buyer" or "Seller". */
  role: string;
  name: string;
  companyId: string | null;
  personId: string | null;
  contact: string | null;
  email: string | null;
  chips?: PartyChip[];
  /** Short figures shown as tiles, e.g. Last heard. */
  stats?: { label: string; value: string }[];
  /** Longer notes, e.g. what they usually buy. `bad` marks a warning. */
  notes?: { label: string; value: React.ReactNode; bad?: boolean }[];
  /** Related items as chips, e.g. other open asks from the same buyer. */
  related?: { label: string; items: { id: string; label: string; onOpen?: () => void }[] };
};

/** Who is on the other side of a listing: a coloured identity block, their standing, the contact and a way into the CRM. */
export function PartyCard({ role, name, companyId, personId, contact, email, chips = [], stats = [], notes = [], related }: PartyCardProps) {
  const profile = companyId ? buildEntryLink("company", companyId) : null;
  const person = personId ? buildEntryLink("people", personId) : null;
  const h = hue(name);
  const style = {
    "--hue-band": `linear-gradient(120deg, hsl(${h} 70% 86%), hsl(${(h + 40) % 360} 70% 92%))`,
    "--hue-fill": `hsl(${h} 60% 78%)`,
    "--hue-ink": `hsl(${h} 55% 22%)`,
  } as React.CSSProperties;
  return (
    <section className={css.card} aria-label={`${role} card`} style={style}>
      <div className={css.band} aria-hidden="true" />
      <div className={css.body}>
        <div className={css.top}>
          <span className={css.avatar} aria-hidden="true">{initials(name)}</span>
          <div className={css.titles}>
            <div className={css.role}>{role}</div>
            <div className={css.name}>{profile ? <a href={profile}>{name}</a> : name}</div>
          </div>
        </div>
        {chips.length > 0 && (
          <div className={css.chips}>{chips.map((chip) => <span key={chip.label} className={css.chip} data-tone={chip.tone}>{chip.label}</span>)}</div>
        )}
        {(contact || email) && (
          <div className={css.person}>
            <span className={css.personIcon} aria-hidden="true"><User size={16} /></span>
            <span className={css.personText}>
              {contact && <strong>{person ? <a href={person}>{contact}</a> : contact}</strong>}
              {email && <a className="mail" href={`mailto:${email}`}>{email}</a>}
            </span>
          </div>
        )}
        {stats.length > 0 && (
          <div className={css.stats}>{stats.map((stat) => <div key={stat.label} className={css.stat}><span>{stat.label}</span><span>{stat.value}</span></div>)}</div>
        )}
        {(notes.length > 0 || related) && (
          <dl className={css.notes}>
            {notes.map((note) => (
              <div key={note.label}>
                <dt>{note.label}</dt>
                <dd className={note.bad ? css.bad : undefined}>{note.value}</dd>
              </div>
            ))}
            {related && related.items.length > 0 && (
              <div>
                <dt>{related.label}</dt>
                <dd className={css.asks}>
                  {related.items.map((item) => item.onOpen
                    ? <button key={item.id} type="button" className={css.ask} onClick={item.onOpen}>{item.label}</button>
                    : <span key={item.id} className={css.ask}>{item.label}</span>)}
                </dd>
              </div>
            )}
          </dl>
        )}
        {!companyId && <p className={css.unlinked}>Not linked to a CRM company yet.</p>}
        {(profile || email) && (
          <div className={css.actions}>
            {profile && <a className={css.primary} href={profile}><ExternalLink size={14} aria-hidden="true" />Open in CRM</a>}
            {email && <a className={css.secondary} href={`mailto:${email}`}><Mail size={14} aria-hidden="true" />Email</a>}
          </div>
        )}
      </div>
    </section>
  );
}

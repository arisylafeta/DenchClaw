"use client";

import { PersonAvatar } from "../person-avatar";
import { SenderAvatar } from "../sender-avatar";
import styles from "./mail.module.css";

export type Participant = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_self?: boolean;
};

function isSelf(person: Participant): boolean {
  return Boolean(person.is_self || person.email?.toLowerCase().endsWith("@rebattery.io"));
}

export function participantLabel(person: Participant): string {
  return isSelf(person) ? `You${person.email ? ` (${person.email})` : ""}` : person.name?.trim() || person.email || "Unknown";
}

export function participantAvatarName(person: Participant): string | null {
  return isSelf(person) ? person.email?.split("@")[0] ?? person.name : person.name ?? person.email;
}

export function groupThreadParticipants(participants: ReadonlyArray<Participant>) {
  const groups = new Map<string, { person: Participant; label: string; emails: string[] }>();
  for (const person of participants) {
    const self = isSelf(person);
    const key = self ? "self" : person.email?.toLowerCase() ?? person.id;
    const existing = groups.get(key);
    if (existing) {
      if (person.email && !existing.emails.some((email) => email.toLowerCase() === person.email!.toLowerCase())) {existing.emails.push(person.email);}
      continue;
    }
    groups.set(key, { person, label: self ? "You" : participantLabel(person), emails: person.email ? [person.email] : [] });
  }
  return [...groups.values()].sort((left, right) => Number(isSelf(left.person)) - Number(isSelf(right.person)));
}

/**
 * Avatar pile + name chips for a thread's participants. Compact mode
 * shows up to N avatars + overflow "+M"; expanded mode lists everyone
 * with their email.
 *
 * Clicking a chip calls `onOpenPerson(id)` so the parent can route to
 * the PersonProfile in the main panel.
 */
export function ParticipantChips({
  participants,
  max = 4,
  onOpenPerson,
  variant = "avatars",
}: {
  participants: ReadonlyArray<Participant>;
  max?: number;
  onOpenPerson?: (id: string) => void;
  variant?: "avatars" | "named" | "compact";
}) {
  if (participants.length === 0) {return null;}
  if (variant === "compact") {
    const groups = groupThreadParticipants(participants);
    return <div className={styles.participantsLine} aria-label="Thread participants">
      {groups.slice(0, max).map(({person,label,emails}) => <span key={isSelf(person) ? "self" : person.email ?? person.id} className={styles.participant} title={emails.join(", ")}>
        <SenderAvatar avatarUrl={person.avatar_url} email={person.email} name={participantAvatarName(person)} size="sm" className="!h-4 !w-4 !text-[9px]" />
        {onOpenPerson && !isSelf(person) && person.id !== person.email
          ? <button type="button" className="max-w-[190px] truncate hover:underline" onClick={() => onOpenPerson(person.id)}>{label}</button>
          : <span className="max-w-[190px] truncate">{label}</span>}
      </span>)}
      {groups.length > max && <span style={{color:"var(--color-text-muted)"}}>+{groups.length-max}</span>}
      <details className={styles.participantDetails}>
        <summary aria-label="Show participant emails">Details</summary>
        <div className={styles.participantPanel}>{groups.map(({person,label,emails}) => <div key={isSelf(person) ? "self" : person.email ?? person.id} className="py-1"><span className="font-medium">{label}</span><div>{emails.join(", ") || "No email recorded"}</div></div>)}</div>
      </details>
    </div>;
  }
  const visible = participants.slice(0, max);
  const overflow = participants.length - visible.length;

  if (variant === "avatars") {
    return (
      <div className="flex items-center -space-x-1.5">
        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenPerson?.(p.id)}
            disabled={!onOpenPerson}
            title={participantLabel(p)}
            className="rounded-full ring-2 ring-[var(--color-bg)] disabled:cursor-default"
          >
            <PersonAvatar
              src={p.avatar_url}
              name={participantAvatarName(p)}
              seed={p.email ?? p.id}
              size="sm"
            />
          </button>
        ))}
        {overflow > 0 && (
          <span
            className="ml-2 text-[11px] tabular-nums"
            style={{ color: "var(--color-text-muted)" }}
          >
            +{overflow}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onOpenPerson?.(p.id)}
          disabled={!onOpenPerson}
          className="inline-flex items-center gap-1.5 rounded-full pl-0.5 pr-2.5 py-0.5 text-[12px] transition-colors disabled:cursor-default"
          style={{
            background: "var(--color-surface-hover)",
            color: "var(--color-text)",
          }}
          title={p.email ?? undefined}
        >
          <PersonAvatar
            src={p.avatar_url}
            name={participantAvatarName(p)}
            seed={p.email ?? p.id}
            size="sm"
          />
          <span className="truncate max-w-[140px]">
            {participantLabel(p)}
          </span>
        </button>
      ))}
      {overflow > 0 && (
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "var(--color-text-muted)" }}
        >
          +{overflow} more
        </span>
      )}
    </div>
  );
}

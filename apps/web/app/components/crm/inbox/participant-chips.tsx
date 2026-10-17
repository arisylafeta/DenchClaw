"use client";

import { PersonAvatar } from "../person-avatar";

export type Participant = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_self?: boolean;
};

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
  variant?: "avatars" | "named";
}) {
  if (participants.length === 0) {return null;}
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
            title={p.name ?? p.email ?? undefined}
            className="rounded-full ring-2 ring-[var(--color-bg)] disabled:cursor-default"
          >
            <PersonAvatar
              src={p.avatar_url}
              name={p.name ?? p.email}
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
            name={p.name ?? p.email}
            seed={p.email ?? p.id}
            size="sm"
          />
          <span className="truncate max-w-[140px]">
            {p.name?.trim() || p.email || "Unknown"}
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

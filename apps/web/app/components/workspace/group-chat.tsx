"use client";
import type { HermesConversation } from "@/lib/hermes-conversations";
import { ProfileAvatar } from "./profile-avatar";

/** Who said it, shown above an agent's message inside a group chat. */
export function GroupAuthor({ profile, name, children }: { profile: string; name?: string; children?: React.ReactNode }) {
  return <div className="flex items-center gap-1.5 pt-2 text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
    <ProfileAvatar name={profile} className="h-5 w-5" />{name || profile}{children}
  </div>;
}

/** Header add-on that marks a chat as a group: overlapping participant avatars plus a "Group" tag. */
export function GroupBadge({ row }: { row: HermesConversation }) {
  return <span className="flex shrink-0 items-center gap-1.5">
    <span className="inline-flex -space-x-1.5" aria-label={`Participants: ${row.participants.map((p) => p.name).join(", ")}`}>
      {row.participants.map((p) => <span key={p.memberId || p.profile} className="rounded-full ring-2 ring-[var(--color-main-bg)]" title={p.name}><ProfileAvatar name={p.profile} className="h-5 w-5" /></span>)}
    </span>
    <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>Group</span>
    {row.blocked && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700" title="Approval, retry or cancellation is waiting in Hermes">Needs attention</span>}
  </span>;
}

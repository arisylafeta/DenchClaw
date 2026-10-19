"use client";
import { useEffect, useState } from 'react';
import type { HermesParticipant } from '@/lib/hermes-conversations';
import type { RoomActivity } from '@/lib/hermes-gateway/room-activity';
import type { RoomDriver } from '@/lib/hermes-native';
import type { RoomTrace } from '@/lib/hermes-gateway/room-trace';
import { GroupAuthor } from '../workspace/group-chat';
import { ThinkingIndicator } from './thinking';
import { Elapsed } from './tool-run';
import { WorkBlock } from './work-block';
import { describeTool } from './describe';
import { formatElapsedDuration } from '@/lib/elapsed-duration';
export type GroupSettlement = { memberId?: string; createdAt?: number; passed?: boolean };
export interface GroupActivityProps {
  conversationKey: string; working: boolean; visible?: boolean;
  roster: HermesParticipant[]; driver?: RoomDriver; settled?: GroupSettlement[];
}
/** Ephemeral work never enters transcript state. The room log wins over a stale activity poll. */
export function GroupActivity({ conversationKey, working, visible = true, roster, driver, settled = [] }: GroupActivityProps) {
  const [activity, setActivity] = useState<RoomActivity>({ members: [], degraded: true });
  useEffect(() => {
    let alive = true; let pending = false;
    setActivity({ members: [], degraded: true });
    if (!working || !visible) return;
    const poll = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(conversationKey)}/activity`);
        if (!response.ok) throw Error('unavailable');
        const data = await response.json();
        if (alive) setActivity(data);
      } catch { if (alive) setActivity({ members: [], degraded: true }); }
      finally { pending = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    document.addEventListener('visibilitychange', poll);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [conversationKey, working, visible]);
  return <GroupWorkingBubbles working={working} activity={activity} roster={roster} driver={driver} settled={settled} />;
}
export function GroupWorkingBubbles({ working, activity, roster, driver, settled = [] }: Pick<GroupActivityProps, 'working' | 'roster' | 'driver' | 'settled'> & { activity: RoomActivity }) {
  const approvals = (driver?.pending_actions ?? []).filter(action => action.kind === 'approval');
  const waiting = new Set(approvals.map(action => action.member_id));
  const running = working ? roster.flatMap(member => {
    const row = activity.members.find(row => row.memberId === member.memberId && row.running);
    const finished = settled.filter(s => s.memberId === member.memberId);
    if (!row || waiting.has(member.memberId) || finished.some(s => !row.startedAt || !s.createdAt || row.startedAt <= s.createdAt)) return [];
    return [{ ...row, profile: member.profile, name: member.name }];
  }) : [];
  return <div className="min-w-0" aria-live="polite">
    {approvals.map((action, i) => <p key={String(action.member_id ?? i)} className="py-2 text-xs text-[var(--color-text-muted)]">Waiting for approval: {roster.find(m => m.memberId === action.member_id)?.name || String(action.member_id || 'agent')}</p>)}
    {running.map(row => <div key={row.memberId} className="min-w-0 py-2" data-member-working={row.memberId}>
      <GroupAuthor profile={row.profile} name={row.name} />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <ThinkingIndicator>Working</ThinkingIndicator><span>{row.tool ? describeTool(row.tool).label : row.status}</span>{row.startedAt && <Elapsed startedAt={row.startedAt} />}
      </div>
    </div>)}
    {working && !running.length && !approvals.length && <div className="py-3 text-xs text-[var(--color-text-muted)]"><ThinkingIndicator>Agents are working</ThinkingIndicator></div>}
  </div>;
}
type TraceSummary = Pick<RoomTrace, 'startedAt' | 'completedAt' | 'steps'>;
export function GroupWorkTrace({ conversationKey, memberId, turnId }: { conversationKey: string; memberId: string; turnId: string }) {
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [trace, setTrace] = useState<RoomTrace | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = `/api/hermes/conversations/${encodeURIComponent(conversationKey)}/trace?member=${encodeURIComponent(memberId)}&turn=${encodeURIComponent(turnId)}`;
  useEffect(() => {
    let alive = true; let retry: ReturnType<typeof setTimeout> | undefined;
    setSummary(null); setTrace(null); setOpen(false); setFailed(false);
    const probe = async (canRetry: boolean) => {
      try {
        const response = await fetch(`${url}&summary=1`);
        const data = response.ok ? await response.json() : null;
        if (!alive) return;
        setSummary(data?.trace ?? null);
        // message.member may reach the log just before turn.settled. One bounded retry
        // runs after the server's history TTL, never an endless per-reply poll.
        if (!data?.trace && canRetry) retry = setTimeout(() => void probe(false), 6000);
      } catch { if (alive && canRetry) retry = setTimeout(() => void probe(false), 6000); }
    };
    void probe(true);
    return () => { alive = false; clearTimeout(retry); };
  }, [url]);
  useEffect(() => {
    if (!open || trace) return;
    let alive = true;
    setFailed(false);
    void fetch(url).then(r => { if (!r.ok) throw Error('unavailable'); return r.json(); }).then(data => { if (alive) { setTrace(data.trace); setFailed(!data.trace); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open, trace, url]);
  if (!summary) return null;
  return <div className="my-1 min-w-0 text-xs text-[var(--color-text-muted)]">
    <button type="button" className="min-h-11 md:min-h-8 rounded px-1 text-left hover:bg-[var(--color-surface-hover)] focus-visible:outline focus-visible:outline-2" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      Worked {formatElapsedDuration(Math.max(0, summary.completedAt - summary.startedAt) / 1000)} · {summary.steps} {summary.steps === 1 ? 'step' : 'steps'}
    </button>
    {open && <div className="mt-1">{trace ? <WorkBlock work={trace.work} live={false} answerStartedAt={trace.completedAt} initiallyOpen /> : <span>{failed ? 'Work trace unavailable' : 'Loading work trace…'}</span>}</div>}
  </div>;
}

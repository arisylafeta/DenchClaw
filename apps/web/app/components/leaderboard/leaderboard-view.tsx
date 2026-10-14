'use client';
import { useEffect, useState } from 'react';
import type { LeaderboardResult, LeaderboardRow } from '@/lib/leaderboard/query';
import { SEGMENTS } from '@/lib/leaderboard/scoring';
const PAGE_SIZE = 50;
const control = 'rounded border px-2 py-1 text-sm bg-transparent';
export function LeaderboardView({onOpenPerson}: {onOpenPerson?: (id: string) => void}) {
  const [q, setQ] = useState(''), [role, setRole] = useState('buyer'), [window, setWindow] = useState(30);
  const [segment, setSegment] = useState(''), [inCrm, setInCrm] = useState(false), [noOffer, setNoOffer] = useState(false);
  const [sort, setSort] = useState('score'), [offset, setOffset] = useState(0), [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<LeaderboardResult | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LeaderboardRow | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(null); setData(null);
    const params = new URLSearchParams({q, window: String(window), sort, limit: String(PAGE_SIZE), offset: String(offset)});
    if (role) params.set('role', role); if (segment) params.set('segment', segment);
    if (inCrm) params.set('inCrm','true'); if (noOffer) params.set('noOffer','true');
    fetch(`/api/leaderboard?${params}`, {signal: abort.signal, cache: 'no-store'}).then(async response => {
      const payload: LeaderboardResult = await response.json();
      if (!response.ok || payload.source === 'error') throw new Error(payload.error || 'Leaderboard unavailable');
      if (!abort.signal.aborted) setData(payload);
    }).catch(error => {if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Leaderboard unavailable');}).finally(() => {if (!abort.signal.aborted) setLoading(false);});
    return () => abort.abort();
  }, [q, role, window, segment, inCrm, noOffer, sort, offset, attempt]);
  const change = (fn: () => void) => {fn(); setOffset(0);};
  const sortColumn = (key: string) => change(() => setSort(sort === key ? `-${key}` : key));
  const open = (row: LeaderboardRow) => {if (row.personId && onOpenPerson) onOpenPerson(row.personId); else setReview(row);};
  return <div className="bulk-trades flex h-full min-h-0 flex-col p-5 gap-4" style={{background: 'var(--bt-bg)', color: 'var(--bt-text)'}}>
    <header><h1 className="text-xl font-semibold">Leaderboard</h1><p className="text-sm opacity-70">Recorded platform activity · intent-weighted, 14-day recency half-life</p></header>
    <section aria-label="Activity counts" className="flex flex-wrap gap-4 text-sm">
      {['active','rising','cooling','dormant','never_active'].map(s => <div key={s}><span className="capitalize">{s.replace('_',' ')}</span> <strong>{data ? data.counts[s as keyof typeof data.counts] : '—'}</strong></div>)}
    </section>
    <div className="flex flex-wrap gap-2 items-center">
      <input aria-label="Search people" placeholder="Name, email, company…" className={control} value={q} onChange={e => change(() => setQ(e.target.value))}/>
      <select aria-label="Role" className={control} value={role} onChange={e => change(() => setRole(e.target.value))}><option value="">All roles</option>{['buyer','supplier','recycler'].map(r => <option key={r} value={r}>{r}</option>)}</select>
      <div aria-label="Activity window" role="group" className="flex gap-1">{[7,30,90].map(days => <button key={days} className={control} aria-pressed={window === days} onClick={() => change(() => setWindow(days))}>{days} days</button>)}</div>
      <select aria-label="Segment" className={control} value={segment} onChange={e => change(() => setSegment(e.target.value))}><option value="">All segments</option>{SEGMENTS.map(s => <option key={s} value={s}>{s.replace('_',' ')}</option>)}</select>
      <label className="text-sm"><input type="checkbox" checked={noOffer} onChange={e => change(() => setNoOffer(e.target.checked))}/> No offer yet (ever)</label>
      <label className="text-sm"><input type="checkbox" checked={inCrm} onChange={e => change(() => setInCrm(e.target.checked))}/> In CRM</label>
    </div>
    {error && <div role="alert" className="rounded border border-red-500 p-3">{error} <button className={control} onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
    {data?.linkPending && <p role="status">Account links pending — PostHog-only identities; CRM matching is unavailable.</p>}
    {loading ? <p role="status">Loading activity…</p> : data && <>
      <div className="overflow-auto flex-1"><table aria-label="User activity leaderboard" className="w-full text-sm text-left"><thead><tr>{[['score','Rank'],['person','Person'],['company','Company'],['role','Role'],['score','Score'],['activeDays','Active days'],['lastSeen','Last seen'],['topActions','Top actions']].map(([key,label],index) => <th key={index} className="p-2 border-b" aria-sort={sort.replace('-','') === key ? sort.startsWith('-') ? 'ascending' : 'descending' : 'none'}><button onClick={() => sortColumn(key)}>{label}</button></th>)}</tr></thead>
      <tbody>{data.rows.map((row,index) => <tr key={row.authUserId} className="border-b cursor-pointer hover:bg-black/5" onClick={() => open(row)}>
        <td className="p-2">{offset + index + 1}</td><td className="p-2"><button className="text-left" onClick={e => {e.stopPropagation(); open(row);}}>{row.name || row.email || row.authUserId}</button><div className="text-xs opacity-70">{row.name ? row.email : ''}</div><div className="flex gap-1 text-xs"><span className="rounded border px-1">{row.segment.replace('_',' ')}</span>{!row.inCrm && <span>Not in CRM</span>}{row.reviewStatus === 'needs_review' && <span>Needs review</span>}{row.reviewStatus === 'link_pending' && <span>Link pending</span>}{row.emailOptedOut && <span>Email opted out</span>}</div></td>
        <td className="p-2">{row.company || '—'}</td><td className="p-2">{row.role || 'Unknown'}</td><td className="p-2" title={`Intent ${row.intentScore}; engagement ${row.engagementScore}`}>{row.score.toFixed(1)}</td><td className="p-2">{row.activeDays}</td><td className="p-2">{row.lastSeen ? new Date(row.lastSeen).toLocaleDateString() : 'Never'}</td><td className="p-2">{row.topActions.slice(0,3).map(a => `${a.event}: ${a.count}`).join(' · ') || '—'}</td>
      </tr>)}</tbody></table>{!data.rows.length && <p className="p-4">No users match these filters.</p>}</div>
      <footer className="flex items-center justify-between text-sm"><span>{data.total} users · as of {new Date(data.asOf).toLocaleString()}</span><div className="flex gap-2"><button className={control} disabled={!offset} onClick={() => setOffset(Math.max(0,offset-PAGE_SIZE))}>Previous</button><span>{Math.floor(offset/PAGE_SIZE)+1} / {Math.max(1,Math.ceil(data.total/PAGE_SIZE))}</span><button className={control} disabled={offset+PAGE_SIZE >= data.total} onClick={() => setOffset(offset+PAGE_SIZE)}>Next</button></div></footer>
    </>}
    {review && <section role="dialog" aria-label="Account link review" className="rounded border p-4"><div className="flex justify-between"><h2 className="font-semibold">Account link review</h2><button onClick={() => setReview(null)}>Close</button></div><p>{review.email || review.authUserId}</p><p>Role: {review.role || 'Unknown'} · {review.reviewStatus.replace('_',' ')}</p><p className="text-sm">No CRM person is linked. Review the platform account identity before linking it; no contact is created automatically.</p></section>}
  </div>;
}

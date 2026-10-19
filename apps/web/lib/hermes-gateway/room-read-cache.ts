export function limitConcurrency(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
/** Pending reads never expire or get evicted. Freshness begins only at completion.
 * Admission waits when all slots are pending; settled entries have active TTL eviction. */
export class BoundedReads<T> {
  private entries = new Map<string, { pending: Promise<T>; until?: number; bytes: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private max: number, private ttl: number, private maxBytes = Infinity) {}
  read(key: string, work: () => Promise<T>): Promise<T> {
    const old = this.entries.get(key);
    if (old && (old.until === undefined || old.until > Date.now())) return old.pending;
    if (old) this.remove(key);
    if (this.entries.size >= this.max) {
      const settled = [...this.entries].find(([, e]) => e.until !== undefined);
      if (settled) this.remove(settled[0]);
      else return Promise.race([...this.entries.values()].map(e => e.pending.catch(() => undefined))).then(() => this.read(key, work));
    }
    const entry = { pending: Promise.resolve().then(work), bytes: 0 } as { pending: Promise<T>; until?: number; bytes: number; timer?: ReturnType<typeof setTimeout> };
    this.entries.set(key, entry);
    void entry.pending.then(value => {
      entry.until = Date.now() + this.ttl;
      entry.bytes = JSON.stringify(value)?.length * 2 || 0;
      entry.timer = setTimeout(() => this.remove(key), this.ttl);
      entry.timer.unref?.();
      while ([...this.entries.values()].reduce((n, e) => n + e.bytes, 0) > this.maxBytes) {
        const victim = [...this.entries].find(([, e]) => e.until !== undefined);
        if (!victim) break;
        this.remove(victim[0]);
      }
    }, () => this.remove(key));
    return entry.pending;
  }
  private remove(key: string) { const entry = this.entries.get(key); if (entry?.timer) clearTimeout(entry.timer); this.entries.delete(key); }
}

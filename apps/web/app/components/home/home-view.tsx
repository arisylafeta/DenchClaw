"use client";

// Home: the CRM landing page. This month's goals for both business lines, the marketplace lever,
// one chart, bulk trades and data health, from /api/home.
import { useCallback, useEffect, useState } from "react";
import type { HomeData } from "@/lib/home";
import { TARGETS, dayLabel, monthOf, shortPounds } from "@/lib/home-metrics";
import { request } from "../bulk-trades/trade-ui";
import { HomeChart } from "./home-chart";
import styles from "./home.module.css";

const NO_DATA = "No data yet";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (n: number, d: number) => (d > 0 ? `${Math.min(100, (n / d) * 100).toFixed(1)}%` : "0%");

export function HomeView() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await request<HomeData>("/api/home"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Home.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className={styles.root}>
      <div className={styles.wrap}>
        {data ? <HomeBody data={data} /> : (
          <header className={styles.top}>
            <div>
              <h1>Home</h1>
              <div className={styles.date}>
                {error
                  ? <span className={styles.error}>{error}<button type="button" className={styles.retry} onClick={() => void load()}>Try again</button></span>
                  : "Loading"}
              </div>
            </div>
          </header>
        )}
      </div>
    </div>
  );
}

function HomeBody({ data }: { data: HomeData }) {
  const { header } = data;
  return (
    <>
      <header className={styles.top}>
        <div>
          <h1>Home</h1>
          <div className={styles.date}>{header.date} · day {header.day} of {header.days_in_month}</div>
        </div>
        <div className={styles.fresh}>
          {header.platform_to ? `Platform data to ${dayLabel(header.platform_to)}` : "Platform data missing"}
          {" · "}
          {header.funnel.stale
            ? <b>{header.funnel.collected_at ? `weekly funnel stale since ${dayLabel(header.funnel.collected_at)}` : "weekly funnel has no data yet"}</b>
            : `weekly funnel to ${dayLabel(header.funnel.collected_at!)}`}
          <br />
          Targets: {header.targets.map((t) => `${t.label} (${t.source})`).join(" · ")}
        </div>
      </header>

      <div className={styles.sec}>This month</div>
      <section className={styles.goals} aria-label="Monthly goals">
        <MarketplaceGoal data={data} />
        <BulkGoal data={data} />
        <FeesGoal data={data} />
      </section>

      <div className={styles.sec}>Marketplace health</div>
      <MarketplaceHealth data={data} />

      <HomeChart overview={data.overview} funnel={data.funnel} />

      <div className={styles.sec}>Bulk trades</div>
      <BulkTrades data={data} />

      <footer className={styles.health} aria-label="Data health">
        {data.health.map((item, i) => (
          <span key={i}>
            {item.warn && <span className={styles.dot} />}
            {item.title && <><b>{item.title}</b> </>}
            {item.text}
          </span>
        ))}
      </footer>
    </>
  );
}

function Meter({ count, target, share, label }: { count: number; target: number; share: number; label: string }) {
  return (
    <div className={styles.meter} role="img" aria-label={label}>
      <i style={{ width: pct(count, target) }} />
      <b style={{ left: `${(share * 100).toFixed(1)}%` }} />
    </div>
  );
}

function GoalCount({ count, pace, unit }: { count: number; pace: NonNullable<HomeData["marketplace"]>["pace"]; unit: string }) {
  return (
    <>
      <div className={styles.fig}><span className={styles.n}>{count}</span><span className={styles.of}>of {pace.target}</span></div>
      <Meter count={count} target={pace.target} share={pace.share_of_month} label={`${count} of ${pace.target} ${unit}, pace for today ${pace.pace}`} />
      <div className={styles.mk}>
        <span>Pace for today: {pace.pace}</span>
        <span>{pace.to_go > 0 ? `${pace.to_go} to go` : "Target met"}</span>
      </div>
    </>
  );
}

function MarketplaceGoal({ data }: { data: HomeData }) {
  const m = data.marketplace;
  return (
    <article className={`${styles.card} ${styles.goal}`}>
      <div className={styles.ghd}><b>Marketplace</b><span>Paid deals</span></div>
      {m ? <GoalCount count={m.paid} pace={m.pace} unit="paid deals" /> : <div className={styles.none}>{NO_DATA}</div>}
      <div className={styles.pair}>
        <div>
          <span>Last paid</span>
          {m?.last_paid_at
            ? <b>{dayLabel(m.last_paid_at)} <small>{plural(m.last_paid_days ?? 0, "day", "days")} ago</small></b>
            : <b className={styles.none}>{NO_DATA}</b>}
        </div>
        <div>
          <span>Fill rate</span>
          {m?.fill && m.fill.rate !== null
            ? <b>{Math.round(m.fill.rate * 100)}% <small>{m.fill.num} paid of {m.fill.den} sent</small></b>
            : <b className={styles.none}>{NO_DATA}</b>}
        </div>
      </div>
    </article>
  );
}

function BulkGoal({ data }: { data: HomeData }) {
  const b = data.bulk_goal;
  const first = b?.closing[0];
  return (
    <article className={`${styles.card} ${styles.goal}`}>
      <div className={styles.ghd}><b>Bulk trades</b><span>Deals closed</span></div>
      {b ? <GoalCount count={b.closed} pace={b.pace} unit="bulk deals" /> : <div className={styles.none}>{NO_DATA}</div>}
      <div className={styles.pair}>
        <div>
          <span>In closing</span>
          {b ? (
            <b>
              {b.closing.length}{" "}
              {first && (
                <small>
                  {first.title}{first.value ? `, ${first.value}` : ""}
                  {b.closing.length > 1 ? ` and ${b.closing.length - 1} more` : ""}
                </small>
              )}
            </b>
          ) : <b className={styles.none}>{NO_DATA}</b>}
        </div>
        <div>
          <span>Lost in {b?.month_label ?? "this month"}</span>
          {b ? <b>{b.lost}</b> : <b className={styles.none}>{NO_DATA}</b>}
        </div>
      </div>
    </article>
  );
}

function FeesGoal({ data }: { data: HomeData }) {
  const f = data.fees;
  const [goalFigure, ...goalRest] = TARGETS.fees_long_term.label.split(" ");
  const year = monthOf(data.now).slice(0, 4);
  const share = f?.top_share ?? null;
  return (
    <article className={`${styles.card} ${styles.goal} ${styles.money}`}>
      <div className={styles.ghd}><b>Platform fees</b><span>{year} to date</span></div>
      {f ? (
        <>
          <div className={styles.fig}><span className={styles.of}>about</span><span className={styles.n}>{shortPounds(f.ytd_gbp)}</span></div>
          {share !== null ? (
            <>
              <div className={styles.conc} role="img" aria-label={`${Math.round(share * 100)} percent of fees from one deal`}>
                <i style={{ flex: share, background: "var(--h-accent)" }} />
                <i style={{ flex: 1 - share, background: "var(--h-accent-soft)" }} />
              </div>
              <div className={styles.note}>
                {Math.round(share * 100)}% from one deal{f.top_label ? ` (${f.top_label})` : ""}. {plural(f.paid_deals_ytd, "paid deal", "paid deals")} in total.
              </div>
            </>
          ) : <div className={styles.note}>No fees yet this year.</div>}
        </>
      ) : <div className={styles.none}>{NO_DATA}</div>}
      <div className={styles.pair}>
        <div>
          <span>{f?.month_label ?? "This month"}</span>
          {f ? <b>{shortPounds(f.month_gbp)}</b> : <b className={styles.none}>{NO_DATA}</b>}
        </div>
        <div>
          <span>Long-term goal</span>
          <b>{goalFigure} <small>{goalRest.join(" ")}</small></b>
        </div>
      </div>
    </article>
  );
}

function MarketplaceHealth({ data }: { data: HomeData }) {
  const r = data.reply;
  const s = data.since_deal;
  const asked = r ? r.within + r.later + r.never : 0;
  return (
    <section className={`${styles.card} ${styles.lever}`} aria-label="Marketplace health">
      <div className={styles.lv}>
        <div className={styles.lvh}>
          <b>Buyers answered by the seller within 24 hours</b>
          {r && asked > 0
            ? <span className={styles.v}>{r.within} <small>of {asked} since {dayLabel(r.since).split(" ")[1]}</small></span>
            : <span className={styles.none}>{NO_DATA}</span>}
        </div>
        {r && asked > 0 && (
          <>
            <div className={styles.stack} role="img" aria-label={`${r.within} within 24 hours, ${r.later} later, ${r.never} never`}>
              <i style={{ flex: r.within, background: "var(--h-accent)" }} />
              <i style={{ flex: r.later, background: "var(--h-accent-mid)" }} />
              <i style={{ flex: r.never, background: "var(--h-never)" }} />
            </div>
            <div className={styles.skey}>
              <span><i style={{ background: "var(--h-accent)" }} />Within 24h <b>{r.within}</b></span>
              <span><i style={{ background: "var(--h-accent-mid)" }} />Later <b>{r.later}</b></span>
              <span><i style={{ background: "var(--h-never)" }} />Never <b>{r.never}</b></span>
              {r.open > 0 && <span className={styles.muted}>Asked in the last day: {r.open}</span>}
              <span className={styles.muted}>Target: {r.target_label}</span>
            </div>
          </>
        )}
      </div>
      <div className={styles.since}>
        <span className={styles.note}>Days since a deal was opened</span>
        {s ? (
          <>
            <span className={styles.v}>{s.days} <small>{s.days === 1 ? "day" : "days"}</small></span>
            <span className={styles.note}>
              {s.enquiries_since === 1 ? "1 enquiry has" : `${s.enquiries_since} enquiries have`} come in since {dayLabel(s.last_at)}
            </span>
          </>
        ) : <span className={styles.none}>{NO_DATA}</span>}
      </div>
    </section>
  );
}

function Row({ label, n, d, colour }: { label: string; n: number; d: number; colour: string }) {
  return (
    <div className={styles.row}>
      <div className={styles.h}><span>{label}</span><b>{n} / {d}</b></div>
      <div className={styles.bar}><i style={{ width: pct(n, d), background: colour }} /></div>
    </div>
  );
}

/** Up to four evenly spaced week labels under the bids chart. */
function axisWeeks(weeks: string[]): string[] {
  if (weeks.length <= 4) {return weeks;}
  return [0, 1, 2, 3].map((i) => weeks[Math.round((i * (weeks.length - 1)) / 3)]);
}

function BulkTrades({ data }: { data: HomeData }) {
  const b = data.bulk;
  if (!b) {
    return <section className={styles.bulk} aria-label="Bulk trades"><article className={`${styles.card} ${styles.bk}`}><div className={styles.none}>{NO_DATA}</div></article></section>;
  }
  const ob = b.order_book;
  const weekly = b.bids.weekly;
  const bidMax = Math.max(1, ...weekly.map((w) => w.all));
  const slot = weekly.length ? 300 / weekly.length : 300;
  const stepMax = Math.max(1, ...b.buyers.steps.map((s) => s.count));
  return (
    <section className={styles.bulk} aria-label="Bulk trades">
      <article className={`${styles.card} ${styles.bk}`}>
        <h3>Order book</h3>
        <div className={styles.d}>A trade clears only where both sides have a price</div>
        <Row label="Open lots with a price" n={ob.priced} d={ob.open} colour="var(--h-accent)" />
        <Row label="Buy-boxes with a max price" n={ob.buy_boxes_priced} d={ob.buy_boxes} colour="var(--h-accent)" />
        <Row label="Lots quiet for 7+ days" n={ob.quiet} d={ob.open} colour="var(--h-never)" />
      </article>
      <article className={`${styles.card} ${styles.bk}`}>
        <h3>Bids</h3>
        <div className={styles.d}>{b.bids.since ? `Recorded since ${dayLabel(b.bids.since)} · firm in purple` : "No bids recorded yet"}</div>
        <div className={styles.lvh} style={{ marginBottom: 8 }}>
          <span className={styles.note}>Last 30 days</span>
          <span className={styles.v} style={{ fontSize: 24 }}>{b.bids.firm_30d} <small>firm of {b.bids.total_30d}</small></span>
        </div>
        {weekly.length > 0 && (
          <>
            <svg className={styles.mini} viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label="Bids per week, firm bids in purple">
              <line x1="0" x2="300" y1="62" y2="62" stroke="var(--h-line-2)" strokeWidth="1" />
              {weekly.map((w, i) => {
                const x = i * slot + slot * 0.25;
                const width = slot * 0.5;
                if (!w.all) {return <rect key={w.week_start} x={x} y="60" width={width} height="2" fill="var(--h-track)" />;}
                const h = (w.all / bidMax) * 54;
                const hf = (w.firm / bidMax) * 54;
                return (
                  <g key={w.week_start}>
                    <rect x={x} y={62 - h} width={width} height={h} rx="1" fill="var(--h-accent-soft)" />
                    {w.firm > 0 && <rect x={x} y={62 - hf} width={width} height={hf} rx="1" fill="var(--h-accent)" />}
                  </g>
                );
              })}
            </svg>
            <div className={`${styles.note} ${styles.axis}`}>
              {axisWeeks(weekly.map((w) => w.week_start)).map((w) => <span key={w}>{dayLabel(w)}</span>)}
            </div>
          </>
        )}
      </article>
      <article className={`${styles.card} ${styles.bk}`}>
        <h3>Buyers on open lots</h3>
        <div className={styles.d}>Furthest step each buyer has reached</div>
        <div className={styles.steps}>
          {b.buyers.steps.map((s) => (
            <div key={s.label} className={`${styles.step} ${s.past ? styles.past : ""}`}>
              <span>{s.label}</span>
              <div className={styles.t}><i style={{ width: `${((s.count / stepMax) * 100).toFixed(1)}%` }} /></div>
              <b>{s.count}</b>
            </div>
          ))}
        </div>
        {b.teaser_note && <div className={styles.note} style={{ marginTop: 10 }}>{b.teaser_note}</div>}
      </article>
    </section>
  );
}

"use client";

import { useMemo, useState } from "react";
import {
  GROUP_TONE,
  contactLabel,
  contactTone,
  dueLabel,
  groupDismantlers,
  platformLabel,
  type Dismantler,
} from "@/lib/dismantlers";
import { DueChip, TONE_HEADING } from "../bulk-trades/trade-chips";
import { darkButtonClass, darkButtonStyle, inputClass, inputStyle } from "../bulk-trades/trade-ui";
import { GoalTag, StageDot, StageTag, metaLine, toneText } from "./dismantler-ui";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";

const COLUMNS = "grid-cols-[minmax(0,1.4fr)_100px_minmax(0,1.8fr)_110px_minmax(0,1fr)_90px]";
const BACKLOG_COLUMNS = "grid-cols-[24px_minmax(0,1.4fr)_140px_160px_minmax(0,1fr)]";
const BACKLOG_PAGE = 50;

type Props = {
  dismantlers: Dismantler[];
  today: string;
  onOpen: (d: Dismantler) => void;
  onStartOutreach: (batch: Dismantler[]) => void;
  onShowBoard: () => void;
};

export function DismantlersList({ dismantlers, today, onOpen, onStartOutreach, onShowBoard }: Props) {
  const groups = groupDismantlers(dismantlers, today);
  const found = dismantlers.filter((d) => d.stage === "Found");
  const parked = dismantlers.filter((d) => d.stage === "Parked").length;

  return (
    <div className={`bulk-trades ${tableStyles.surface} flex min-w-[960px] flex-col gap-5`}>
      {groups.length ? (
        <>
          <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-4 border-b px-3 py-2 font-medium`}>
            <span>Dismantler</span><span>Stage</span><span>Next step</span><span>Due</span><span>On ReBattery</span><span>Last contact</span>
          </div>
          {groups.map((group) => (
            <section key={group.name} className="flex flex-col gap-1.5" aria-label={group.name}>
              <h2 className="flex items-center gap-2 px-1 text-[13px] font-semibold" style={{ color: TONE_HEADING[GROUP_TONE[group.name]] }}>
                {group.name}
                <span className="font-medium" style={{ color: "var(--bt-muted)" }}>{group.dismantlers.length}</span>
              </h2>
              <div className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
                {group.dismantlers.map((d) => (
                  <div
                    key={d.id}
                    data-table-part="grid-row"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        onOpen(d);
                      }
                    }}
                    onClick={() => onOpen(d)}
                    className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]`}
                    style={{ borderColor: "var(--bt-divider)" }}
                  >
                    <TableCellContent>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold">{d.name}</span>
                        {d.goal && <GoalTag />}
                      </div>
                      <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{metaLine(d)}</div>
                    </div>
                    </TableCellContent>
                    <TableCellContent><span><StageTag stage={d.stage} /></span></TableCellContent>
                    <TableCellContent>
                    <div className="min-w-0">
                      <div className="text-xs leading-[1.35]" style={{ color: d.next_step ? undefined : "var(--bt-muted)" }}>
                        {d.next_step ?? "Set a next step"}
                      </div>
                      {d.next_step_person_name && (
                        <div className="mt-0.5 text-xs" style={{ color: "var(--bt-muted)" }}>
                          For {d.next_step_person_name}
                        </div>
                      )}
                    </div>
                    </TableCellContent>
                    <TableCellContent><span><DueChip label={dueLabel(d, today)} tone={GROUP_TONE[group.name]} /></span></TableCellContent>
                    <TableCellContent><span className="truncate text-xs" style={{ color: d.platform ? "var(--bt-text)" : "var(--bt-muted)" }}>{platformLabel(d.platform) || "No account yet"}</span></TableCellContent>
                    <TableCellContent><span className="text-xs" style={{ color: toneText(contactTone(d, today)) }}>{contactLabel(d, today)}</span></TableCellContent>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <p className="px-1 text-sm" style={{ color: "var(--bt-muted)" }}>
          Nobody in play yet. Pick a batch from Found below and start outreach.
        </p>
      )}

      <Backlog found={found} onOpen={onOpen} onStartOutreach={onStartOutreach} />

      {parked > 0 && (
        <button type="button" onClick={onShowBoard} className="self-start text-[13px] hover:underline" style={{ color: "var(--bt-muted)" }}>
          {parked} parked · see on the board
        </button>
      )}
    </div>
  );
}

/** Found: the backlog. Search, filter by country, tick a batch and start outreach. */
function Backlog({ found, onOpen, onStartOutreach }: {
  found: Dismantler[];
  onOpen: (d: Dismantler) => void;
  onStartOutreach: (batch: Dismantler[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("All");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(BACKLOG_PAGE);

  const countries = useMemo(() => {
    const tally = new Map<string, number>();
    for (const d of found) if (d.country) tally.set(d.country, (tally.get(d.country) ?? 0) + 1);
    return ["All", ...[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)];
  }, [found]);

  const term = query.trim().toLowerCase();
  const rows = found
    .filter((d) => country === "All" || d.country === country)
    .filter((d) => !term || d.name.toLowerCase().includes(term) || (d.ebay_username ?? "").toLowerCase().includes(term))
    .sort((a, b) => (b.ebay_listings ?? -1) - (a.ebay_listings ?? -1) || a.name.localeCompare(b.name));
  const visible = rows.slice(0, shown);
  const batch = found.filter((d) => picked.has(d.id));
  const allVisiblePicked = visible.length > 0 && visible.every((d) => picked.has(d.id));

  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVisible = () => setPicked((current) => {
    const next = new Set(current);
    for (const d of visible) if (allVisiblePicked) next.delete(d.id); else next.add(d.id);
    return next;
  });

  return (
    <section aria-label="Found" className="mt-2 border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-[var(--bt-row-hover)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="m9 18 6-6-6-6" />
        </svg>
        <StageDot stage="Found" />
        <span className="text-[15px] font-semibold">Found</span>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          {found.length} not contacted yet{found.length ? " · pick a batch to start outreach" : ""}
        </span>
      </button>
      {open && found.length > 0 && (
        <div className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
          <div data-table-part="toolbar" className="flex flex-wrap items-center gap-2.5 border-b px-5 py-3" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}>
            <input
              data-table-part="search"
              type="search"
              aria-label="Search found dismantlers"
              placeholder="Search name or eBay seller"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setShown(BACKLOG_PAGE); }}
              className={`${inputClass} !h-8 !w-[280px] text-xs`}
              style={inputStyle}
            />
            <div role="group" aria-label="Country" className="flex flex-wrap border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
              {countries.map((name) => (
                <button key={name} type="button" aria-pressed={country === name} onClick={() => { setCountry(name); setShown(BACKLOG_PAGE); }}
                  className="h-8 px-3 text-xs font-medium"
                  style={country === name ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { color: "var(--bt-text)" }}>
                  {name}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
              {batch.length ? `${batch.length} selected` : "Tick dismantlers to contact"}
            </span>
            <button type="button" disabled={!batch.length} onClick={() => onStartOutreach(batch)}
              className={`${darkButtonClass} !h-8`} style={darkButtonStyle}>
              Start outreach
            </button>
          </div>
          <div data-table-part="grid-header" className={`grid ${BACKLOG_COLUMNS} items-center gap-3.5 border-b px-3 py-2 font-medium`} style={{ borderColor: "var(--bt-divider)" }}>
            <input type="checkbox" aria-label="Select all shown" checked={allVisiblePicked} onChange={toggleVisible} className="h-4 w-4 accent-[var(--bt-text)]" />
            <span>Dismantler</span><span>Country</span><span>eBay battery listings</span><span>Found via</span>
          </div>
          {visible.map((d) => (
            <div key={d.id} data-table-part="grid-row" className={`grid ${BACKLOG_COLUMNS} items-center gap-3.5 border-b px-3 py-2 text-xs`}
              style={{ borderColor: "var(--bt-divider)", background: picked.has(d.id) ? "var(--bt-bg)" : undefined }}>
              <TableCellContent><input type="checkbox" aria-label={`Select ${d.name}`} checked={picked.has(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-[var(--bt-text)]" /></TableCellContent>
              <TableCellContent>
              <div className="min-w-0">
                <button type="button" onClick={() => onOpen(d)} className="truncate text-left font-semibold hover:underline">{d.name}</button>
                {d.ebay_username && <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{d.ebay_username}</div>}
              </div>
              </TableCellContent>
              <TableCellContent><span className="text-xs">{d.country ?? ""}</span></TableCellContent>
              <TableCellContent><span className="bt-mono text-xs">{d.ebay_listings ?? ""}</span></TableCellContent>
              <TableCellContent><span className="truncate text-xs" style={{ color: "var(--bt-muted)" }}>{d.source ?? ""}</span></TableCellContent>
            </div>
          ))}
          <div data-table-part="footer" className="flex items-center gap-2 px-5 py-3 text-xs" style={{ color: "var(--bt-muted)" }}>
            {rows.length ? `Showing ${visible.length} of ${rows.length}` : "No matches."}
            {rows.length > visible.length && (
              <button type="button" onClick={() => setShown((count) => count + BACKLOG_PAGE)} className="font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
                Show more
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

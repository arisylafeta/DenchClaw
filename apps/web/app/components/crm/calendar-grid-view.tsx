"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarMode } from "@/lib/object-filters";
import type { EventDetailPerson } from "./event-list-item";
import { EventPopover } from "./event-popover";
import { CrmEmptyState, CrmLoadingState } from "./crm-list-shell";

// ---------------------------------------------------------------------------
// Types — mirrors the shape returned by /api/crm/calendar so the grid can be
// fetched and rendered without going through the parent list view.
// ---------------------------------------------------------------------------

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  organizer: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
  attendees: EventDetailPerson[];
};

type ChipClickHandler = (event: EventRow, rect: DOMRect) => void;

// ---------------------------------------------------------------------------
// Local-time date helpers (kept in this file so the grid stays self-contained;
// matching the shape used by cron-dashboard.tsx so behavior is consistent).
// ---------------------------------------------------------------------------

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function addLocalDays(date: Date, days: number): Date {
  const next = startOfLocalDay(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addLocalMonths(date: Date, months: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), 1);
  next.setMonth(next.getMonth() + months);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), maxDay));
  return next;
}

function addLocalYears(date: Date, years: number): Date {
  const next = new Date(date.getFullYear() + years, date.getMonth(), 1);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), maxDay));
  return next;
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayKey(d: Date): string {
  return formatLocalDate(d);
}

function parseDayKey(dk: string): Date | null {
  const m = dk.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {return null;}
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function buildEventsByDay(events: EventRow[]): Map<string, EventRow[]> {
  const map = new Map<string, EventRow[]>();
  for (const event of events) {
    if (!event.start_at) {continue;}
    const at = new Date(event.start_at);
    if (Number.isNaN(at.getTime())) {continue;}
    const k = dayKey(at);
    const arr = map.get(k) ?? [];
    arr.push(event);
    map.set(k, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const aT = a.start_at ? Date.parse(a.start_at) : 0;
      const bT = b.start_at ? Date.parse(b.start_at) : 0;
      return aT - bT;
    });
  }
  return map;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// EventChip — minimal pill rendered inside grid cells. Captures the chip's
// bounding rect on click so the parent can anchor a popover next to it.
// ---------------------------------------------------------------------------

function EventChip({
  event,
  onClick,
}: {
  event: EventRow;
  onClick: ChipClickHandler;
}) {
  const time = event.start_at ? formatTime(new Date(event.start_at)) : "";
  const title = event.title?.trim() || "(no title)";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
        onClick(event, rect);
      }}
      className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate cursor-pointer"
      style={{
        background: "color-mix(in srgb, var(--color-accent-fill) 15%, transparent)",
        color: "var(--color-accent)",
      }}
      title={time ? `${time} · ${title}` : title}
    >
      {time && <span className="opacity-80 mr-1">{time}</span>}
      <span>{title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CalendarGridView({
  onOpenPerson,
  onOpenCompany,
}: {
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => startOfLocalDay(new Date()));
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ event: EventRow; rect: DOMRect } | null>(null);

  // Visible window — matches the cron view's range derivation per mode.
  const { rangeFrom, rangeTo } = useMemo(() => {
    const y = anchor.getFullYear();
    const m = anchor.getMonth();
    if (mode === "day") {
      const start = new Date(y, m, anchor.getDate());
      return { rangeFrom: start, rangeTo: addLocalDays(start, 1) };
    }
    if (mode === "week") {
      const start = startOfLocalWeek(anchor);
      return { rangeFrom: start, rangeTo: addLocalDays(start, 7) };
    }
    if (mode === "year") {
      return { rangeFrom: new Date(y, 0, 1), rangeTo: new Date(y + 1, 0, 1) };
    }
    // month — surrounding 6 weeks so prior/next-month overflow cells populate.
    const first = new Date(y, m, 1);
    const start = startOfLocalWeek(first);
    return { rangeFrom: start, rangeTo: addLocalDays(start, 42) };
  }, [anchor, mode]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("from", rangeFrom.toISOString());
    params.set("to", rangeTo.toISOString());
    params.set("limit", "500");
    fetch(`/api/crm/calendar?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) {throw new Error(`HTTP ${r.status}`);}
        return r.json() as Promise<{ events: EventRow[]; total: number }>;
      })
      .then((body) => setEvents(body.events))
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load calendar.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [rangeFrom, rangeTo]);

  const eventsByDay = useMemo(() => buildEventsByDay(events), [events]);
  const todayStr = dayKey(new Date());

  const navigate = useCallback(
    (delta: number) => {
      setAnchor((d) => {
        if (mode === "month") {return addLocalMonths(d, delta);}
        if (mode === "week") {return addLocalDays(d, delta * 7);}
        if (mode === "day") {return addLocalDays(d, delta);}
        return addLocalYears(d, delta);
      });
    },
    [mode],
  );

  const handleChipClick = useCallback<ChipClickHandler>((event, rect) => {
    setSelected({ event, rect });
  }, []);

  const headerTitle = useMemo(() => {
    if (mode === "day") {
      return anchor.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }
    if (mode === "week") {
      const start = startOfLocalWeek(anchor);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const sameMonth = start.getMonth() === end.getMonth();
      if (sameMonth) {
        return `${start.toLocaleDateString(undefined, { month: "long" })} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
      }
      return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (mode === "year") {return String(anchor.getFullYear());}
    return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }, [anchor, mode]);

  return (
    <div className="px-6 py-4">
      {/* Calendar header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-lg cursor-pointer"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Previous"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
            {headerTitle}
          </h2>
          <button
            type="button"
            onClick={() => navigate(1)}
            className="p-1.5 rounded-lg cursor-pointer"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Next"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <button
            type="button"
            onClick={() => setAnchor(startOfLocalDay(new Date()))}
            className="text-xs px-2.5 py-1 rounded-lg ml-2 cursor-pointer"
            style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
          >
            Today
          </button>
        </div>
        <div
          className="flex items-center gap-1 rounded-lg p-0.5"
          style={{ background: "var(--color-surface-hover)" }}
        >
          {(["day", "week", "month", "year"] as CalendarMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className="px-3 py-1 rounded-md text-xs font-medium cursor-pointer capitalize"
              style={{
                background: mode === m ? "var(--color-surface)" : "transparent",
                color: mode === m ? "var(--color-text)" : "var(--color-text-muted)",
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {error}
        </div>
      )}

      {loading && events.length === 0 ? (
        <CrmLoadingState />
      ) : !loading && events.length === 0 ? (
        <CrmEmptyState
          title="No events in this range"
          description="Try a different month, or connect Google Calendar in onboarding to import events."
        />
      ) : (
        <>
          {mode === "day" && (
            <DayView
              anchor={anchor}
              eventsByDay={eventsByDay}
              todayStr={todayStr}
              onChipClick={handleChipClick}
            />
          )}
          {mode === "week" && (
            <WeekView
              anchor={anchor}
              eventsByDay={eventsByDay}
              todayStr={todayStr}
              onChipClick={handleChipClick}
              onSelectDay={(dk) => {
                const parsed = parseDayKey(dk);
                if (parsed) {
                  setAnchor(parsed);
                  setMode("day");
                }
              }}
            />
          )}
          {mode === "month" && (
            <MonthView
              anchor={anchor}
              eventsByDay={eventsByDay}
              todayStr={todayStr}
              onChipClick={handleChipClick}
            />
          )}
          {mode === "year" && (
            <YearView
              anchor={anchor}
              eventsByDay={eventsByDay}
              todayStr={todayStr}
              onSelectMonth={(d) => {
                setAnchor(d);
                setMode("month");
              }}
            />
          )}
        </>
      )}

      {selected && (
        <EventPopover
          event={selected.event}
          anchor={selected.rect}
          onClose={() => setSelected(null)}
          onOpenPerson={onOpenPerson}
          onOpenCompany={onOpenCompany}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

function DayView({
  anchor,
  eventsByDay,
  todayStr,
  onChipClick,
}: {
  anchor: Date;
  eventsByDay: Map<string, EventRow[]>;
  todayStr: string;
  onChipClick: ChipClickHandler;
}) {
  const dk = dayKey(anchor);
  const events = eventsByDay.get(dk) ?? [];
  const isToday = dk === todayStr;
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const eventsByHour = useMemo(() => {
    const map = new Map<number, EventRow[]>();
    for (const ev of events) {
      if (!ev.start_at) {continue;}
      const h = new Date(ev.start_at).getHours();
      const arr = map.get(h) ?? [];
      arr.push(ev);
      map.set(h, arr);
    }
    return map;
  }, [events]);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
    >
      {hours.map((h) => {
        const hourEvents = eventsByHour.get(h) ?? [];
        const nowHour = new Date().getHours();
        const isCurrentHour = isToday && h === nowHour;
        return (
          <div
            key={h}
            className="flex"
            style={{
              borderBottom: h < 23 ? "1px solid var(--color-border)" : undefined,
              background: isCurrentHour ? "color-mix(in srgb, var(--color-accent-fill) 4%, transparent)" : undefined,
            }}
          >
            <div
              className="w-16 flex-shrink-0 px-3 py-2 text-right text-[11px] font-medium"
              style={{ color: "var(--color-text-muted)", borderRight: "1px solid var(--color-border)" }}
            >
              {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
            </div>
            <div className="flex-1 min-h-[36px] px-2 py-1 flex flex-wrap gap-1 items-start">
              {hourEvents.map((ev) => (
                <EventChip key={ev.id} event={ev} onClick={onChipClick} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week view
// ---------------------------------------------------------------------------

function WeekView({
  anchor,
  eventsByDay,
  todayStr,
  onChipClick,
  onSelectDay,
}: {
  anchor: Date;
  eventsByDay: Map<string, EventRow[]>;
  todayStr: string;
  onChipClick: ChipClickHandler;
  onSelectDay: (dk: string) => void;
}) {
  const weekStart = startOfLocalWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="grid grid-cols-7" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {days.map((d) => {
          const dk = dayKey(d);
          const isToday = dk === todayStr;
          return (
            <button
              key={dk}
              type="button"
              onClick={() => onSelectDay(dk)}
              className="px-2 py-2 text-center cursor-pointer"
              style={{ borderRight: d.getDay() < 6 ? "1px solid var(--color-border)" : undefined }}
            >
              <div
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: "var(--color-text-muted)" }}
              >
                {d.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div
                className="text-sm font-semibold"
                style={{ color: isToday ? "var(--color-accent)" : "var(--color-text)" }}
              >
                {d.getDate()}
              </div>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const dk = dayKey(d);
          const events = eventsByDay.get(dk) ?? [];
          const isToday = dk === todayStr;
          return (
            <div
              key={dk}
              className="min-h-[200px] p-1.5"
              style={{
                borderRight: d.getDay() < 6 ? "1px solid var(--color-border)" : undefined,
                background: isToday ? "color-mix(in srgb, var(--color-accent-fill) 4%, transparent)" : undefined,
              }}
            >
              <div className="space-y-0.5">
                {events.slice(0, 8).map((ev) => (
                  <EventChip key={ev.id} event={ev} onClick={onChipClick} />
                ))}
                {events.length > 8 && (
                  <div className="text-[9px] px-1" style={{ color: "var(--color-text-muted)" }}>
                    +{events.length - 8} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------

function MonthView({
  anchor,
  eventsByDay,
  todayStr,
  onChipClick,
}: {
  anchor: Date;
  eventsByDay: Map<string, EventRow[]>;
  todayStr: string;
  onChipClick: ChipClickHandler;
}) {
  const weeks = useMemo(() => {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const start = startOfLocalWeek(firstOfMonth);
    const weeksArr: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const week: Date[] = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(dt.getDate() + w * 7 + d);
        week.push(dt);
      }
      weeksArr.push(week);
    }
    return weeksArr;
  }, [anchor]);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="grid grid-cols-7" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="px-2 py-2 text-center text-[11px] font-medium uppercase tracking-wider"
            style={{ color: "var(--color-text-muted)" }}
          >
            {d}
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div
          key={wi}
          className="grid grid-cols-7"
          style={{ borderBottom: wi < 5 ? "1px solid var(--color-border)" : undefined }}
        >
          {week.map((day) => {
            const dk = dayKey(day);
            const events = eventsByDay.get(dk) ?? [];
            const isCurrentMonth = day.getMonth() === anchor.getMonth();
            const isToday = dk === todayStr;
            return (
              <div
                key={dk}
                className="min-h-[80px] p-1.5"
                style={{
                  borderRight: day.getDay() < 6 ? "1px solid var(--color-border)" : undefined,
                  opacity: isCurrentMonth ? 1 : 0.4,
                  background: isToday ? "color-mix(in srgb, var(--color-accent-fill) 5%, transparent)" : undefined,
                }}
              >
                <div
                  className="text-xs font-medium mb-1"
                  style={{ color: isToday ? "var(--color-accent)" : "var(--color-text-muted)" }}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {events.slice(0, 3).map((ev) => (
                    <EventChip key={ev.id} event={ev} onClick={onChipClick} />
                  ))}
                  {events.length > 3 && (
                    <div className="text-[9px] px-1" style={{ color: "var(--color-text-muted)" }}>
                      +{events.length - 3} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Year view
// ---------------------------------------------------------------------------

function YearView({
  anchor,
  eventsByDay,
  todayStr,
  onSelectMonth,
}: {
  anchor: Date;
  eventsByDay: Map<string, EventRow[]>;
  todayStr: string;
  onSelectMonth: (d: Date) => void;
}) {
  const year = anchor.getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-4">
      {months.map((month) => {
        const firstOfMonth = new Date(year, month, 1);
        const startDow = firstOfMonth.getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cells: (number | null)[] = [];
        for (let i = 0; i < startDow; i++) {cells.push(null);}
        for (let d = 1; d <= daysInMonth; d++) {cells.push(d);}

        let monthEventCount = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dk = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          monthEventCount += (eventsByDay.get(dk) ?? []).length;
        }

        return (
          <button
            key={month}
            type="button"
            onClick={() => onSelectMonth(firstOfMonth)}
            className="rounded-xl p-3 text-left cursor-pointer transition-colors"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface)";
            }}
          >
            <div className="text-xs font-semibold mb-2" style={{ color: "var(--color-text)" }}>
              {firstOfMonth.toLocaleDateString(undefined, { month: "short" })}
            </div>
            <div className="grid grid-cols-7 gap-px">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div
                  key={i}
                  className="text-[8px] text-center font-medium"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {d}
                </div>
              ))}
              {cells.map((d, i) => {
                if (d === null) {return <div key={`e-${i}`} />;}
                const dk = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const dayEvents = eventsByDay.get(dk) ?? [];
                const isToday = dk === todayStr;
                const hasEvents = dayEvents.length > 0;
                return (
                  <div
                    key={dk}
                    className="text-[9px] text-center rounded-sm leading-[16px]"
                    style={{
                      color: isToday ? "var(--color-accent)" : hasEvents ? "var(--color-text)" : "var(--color-text-muted)",
                      fontWeight: isToday || hasEvents ? 600 : 400,
                      background: hasEvents
                        ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                        : undefined,
                    }}
                  >
                    {d}
                  </div>
                );
              })}
            </div>
            {monthEventCount > 0 && (
              <div className="text-[9px] mt-1.5" style={{ color: "var(--color-text-muted)" }}>
                {monthEventCount} event{monthEventCount !== 1 ? "s" : ""}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

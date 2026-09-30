"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dayMonth, type TradeOwner } from "@/lib/bulk-trades";
import {
  GROUP_TONE,
  JOURNEY,
  TO_REACH_NEXT,
  dismantlerGroup,
  dueLabel,
  addDays,
  nextStage,
  type Dismantler,
  type DismantlerPatch,
  type JourneyStage,
} from "@/lib/dismantlers";
import type { Activity, DismantlerDetail } from "@/lib/crm-postgres/dismantlers";
import { firstName, greeting } from "@/lib/bulk-trade-details";
import { Card, ErrorText, buttonClass, buttonStyle, darkButtonStyle, request } from "../bulk-trades/trade-ui";
import { EditDismantlerDialog, EmailDialog, ParkDialog, SetNextDialog } from "./dismantler-dialogs";
import { GoalTag, STAGE_DOT, StageTag, dismantlerUrl } from "./dismantler-ui";

type Props = {
  id: string;
  owners: TradeOwner[];
  today: string;
  onBack: () => void;
  /** Keeps the list in step with edits made here. */
  onSaved: (d: Dismantler) => void;
};

export function DismantlerPage({ id, owners, today, onBack, onSaved }: Props) {
  const [detail, setDetail] = useState<DismantlerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [parking, setParking] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await request<DismantlerDetail>(dismantlerUrl(id)));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the dismantler.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  /** Saves a change; the page reloads so history and activity stay current. */
  const save = useCallback(async (patch: DismantlerPatch) => {
    const { dismantler } = await request<{ dismantler: Dismantler }>(dismantlerUrl(id), { method: "PATCH", body: JSON.stringify(patch) });
    setDetail((current) => (current ? { ...current, dismantler } : current));
    onSaved(dismantler);
    void load();
  }, [id, onSaved, load]);

  const run = async (patch: DismantlerPatch) => {
    setError(null);
    try { await save(patch); } catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
  };

  if (!detail) {
    return (
      <div className="px-8 py-6">
        <button type="button" onClick={onBack} className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Dismantlers</button>
        {loadError ? <ErrorText error={loadError} /> : <p className="mt-4 text-sm" style={{ color: "var(--bt-muted)" }}>Loading…</p>}
      </div>
    );
  }

  const d = detail.dismantler;
  const meta = [
    d.country,
    d.ebay_username ? `${d.ebay_username} on eBay` : null,
    d.ebay_listings != null ? `${d.ebay_listings} battery listings on eBay` : null,
    d.owner_name ? `owner ${d.owner_name}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2.5 border-b px-8 pb-5 pt-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          <button type="button" onClick={onBack} className="hover:underline">Dismantlers</button> / {d.name}
        </nav>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em]">{d.name}</h1>
          <StageTag stage={d.stage} />
          {d.goal && <GoalTag />}
          <span className="flex-1" />
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setEditing(true)}>Edit</button>
          {d.stage === "Parked" ? (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void run({ stage: d.parked_from ?? "Found" })}>
              Bring back to {d.parked_from ?? "Found"}
            </button>
          ) : (
            <button type="button" className={buttonClass} style={{ ...buttonStyle, color: "var(--bt-muted)" }} onClick={() => setParking(true)}>Park…</button>
          )}
        </div>
        {meta && <p className="text-sm" style={{ color: "var(--bt-text-2)" }}>{meta}</p>}
        <ErrorText error={error} />
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-auto px-8 pb-8 pt-6">
        <Journey d={d} today={today} onMove={(stage) => void run({ stage })} />
        <NextStepBar detail={detail} today={today} onSave={save} />
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <OnReBattery d={d} error={detail.platform_error ?? null} onEdit={() => setEditing(true)} />
          <ActivityCard activity={detail.activity} />
        </div>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Card label="Contacts" className="flex flex-col gap-2 px-5 py-[18px]">
            <h2 className="text-base font-semibold">Contacts</h2>
            {detail.people.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {detail.people.map((person) => (
                  <li key={person.id}>
                    {person.name}{person.job_title ? `, ${person.job_title}` : ""}
                    {person.email && <span style={{ color: "var(--bt-muted)" }}> · {person.email}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm" style={{ color: "var(--bt-muted)" }}>Nobody yet.</p>
            )}
            <p className="text-xs" style={{ color: "var(--bt-muted)" }}>People at {d.name} in the CRM. Add people on the company in the CRM.</p>
          </Card>
          <Notes d={d} onSave={run} />
        </div>
      </main>

      {editing && <EditDismantlerDialog dismantler={d} owners={owners} onClose={() => setEditing(false)} onSave={async (patch) => { await save(patch); setEditing(false); }} />}
      {parking && <ParkDialog dismantler={d} onClose={() => setParking(false)} onSave={async (patch) => { await save({ stage: "Parked", ...patch }); setParking(false); }} />}
    </div>
  );
}

function Journey({ d, today, onMove }: { d: Dismantler; today: string; onMove: (stage: JourneyStage) => void }) {
  const current = d.stage === "Parked" ? d.parked_from ?? "Found" : d.stage;
  const index = JOURNEY.indexOf(current as JourneyStage);
  const next = nextStage(current);
  const days = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.stage_since}T00:00:00Z`)) / 86_400_000));

  return (
    <Card label="Journey" className="flex flex-col gap-3.5 px-5 py-[18px]">
      <ol className="grid grid-cols-4 gap-2">
        {JOURNEY.map((stage, position) => {
          const state = position < index ? "done" : position === index ? "now" : "todo";
          return (
            <li key={stage} className="flex flex-col gap-1.5" aria-current={state === "now" ? "step" : undefined}>
              <span aria-hidden="true" className="h-1" style={{ background: state === "done" ? "var(--bt-text)" : state === "now" ? STAGE_DOT[stage] : "var(--bt-divider)" }} />
              <span className="flex items-center gap-1.5 text-[13px]"
                style={{ fontWeight: state === "now" ? 700 : 500, color: state === "todo" ? "var(--bt-muted)" : "var(--bt-text)" }}>
                {state === "done" && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--bt-green)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
                {stage}
              </span>
              {state === "now" && (
                <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
                  {d.stage === "Parked" ? "parked here" : `since ${dayMonth(d.stage_since)} · ${days} ${days === 1 ? "day" : "days"}`}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        <p className="min-w-[240px] flex-1 text-sm">
          {d.stage === "Parked" ? (
            <><span className="font-semibold">Parked:</span> {d.park_reason ?? "no reason given"}{d.revisit_on ? `. Revisit ${dayMonth(d.revisit_on)}.` : "."}</>
          ) : (
            <>
              {TO_REACH_NEXT[current as JourneyStage]}
              {d.stage !== d.saved_stage && " ReBattery shows they are here."}
            </>
          )}
        </p>
        {next && d.stage !== "Parked" && (
          <button type="button" onClick={() => onMove(next)} className={buttonClass} style={buttonStyle}>Move to {next} →</button>
        )}
      </div>
    </Card>
  );
}

const TONE_STYLE = {
  red: { background: "var(--bt-red-bg)", color: "var(--bt-red)", borderColor: "var(--bt-red-border)" },
  amber: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" },
  grey: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" },
} as const;

/** One quiet line: when, what, for whom, and the actions. The same bar as on a trade. */
function NextStepBar({ detail, today, onSave }: { detail: DismantlerDetail; today: string; onSave: (patch: DismantlerPatch) => Promise<void> }) {
  const d = detail.dismantler;
  const [setting, setSetting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const due = { text: dueLabel(d, today), tone: GROUP_TONE[dismantlerGroup(d, today)] };
  const person = detail.people.find((candidate) => candidate.id === d.next_step_person_id)
    ?? detail.people.find((candidate) => candidate.email);

  useEffect(() => {
    if (!snoozing) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.current?.contains(event.target as Node)) setSnoozing(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [snoozing]);

  async function snooze(days: number) {
    setSnoozing(false);
    setError(null);
    try {
      await onSave({ next_step_due: addDays(d.next_step_due && d.next_step_due > today ? d.next_step_due : today, days) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not snooze.");
    }
  }

  const small = "inline-flex h-8 items-center whitespace-nowrap border px-3 text-[13px] font-medium";
  return (
    <section aria-label="Next step" className="flex flex-wrap items-center gap-x-4 gap-y-2 border px-4 py-3"
      style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <span className="shrink-0 whitespace-nowrap border px-2 py-0.5 text-xs font-medium" style={TONE_STYLE[due.tone]}>
        {d.next_step ? due.text : "No next step"}
      </span>
      <div className="min-w-[220px] flex-1">
        <div className="text-[15px] font-medium leading-snug">{d.next_step ?? "Set one so this dismantler comes back at the right time."}</div>
        {d.next_step_person_name && (
          <div className="mt-0.5 text-[13px]" style={{ color: "var(--bt-muted)" }}>
            For {d.next_step_person_name} · {d.name}
          </div>
        )}
        <ErrorText error={error} />
      </div>
      {d.next_step && (
        <button type="button" onClick={() => setEmailing(true)} className={`${small} hover:bg-[var(--bt-accent-hover)]`}
          style={{ background: "var(--bt-accent)", color: "var(--bt-on-accent)", borderColor: "var(--bt-accent)" }}>
          {person ? `Email ${firstName(person.name)}` : "Email"}
        </button>
      )}
      <button type="button" onClick={() => setSetting(true)} className={small} style={d.next_step ? buttonStyle : darkButtonStyle}>
        {d.next_step ? "Done, set next" : "Set next step"}
      </button>
      {d.next_step && (
        <div ref={menu} className="relative">
          <button type="button" aria-expanded={snoozing} onClick={() => setSnoozing((open) => !open)} className="h-8 px-2 text-[13px] font-medium" style={{ color: "var(--bt-muted)" }}>
            Snooze
          </button>
          {snoozing && (
            <div role="menu" className="absolute right-0 top-9 z-10 flex w-40 flex-col border py-1 shadow-lg"
              style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
              {([["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]] as const).map(([label, days]) => (
                <button key={label} type="button" role="menuitem" onClick={() => void snooze(days)} className="px-3 py-2 text-left text-sm hover:bg-[var(--bt-row-hover)]">
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {emailing && (
        <EmailDialog
          dismantler={d}
          to={person?.email ?? ""}
          subject={`ReBattery and ${d.name}`}
          body={`${greeting(person?.name)}\n\n`}
          onClose={() => setEmailing(false)}
        />
      )}
      {setting && <SetNextDialog detail={detail} today={today} onClose={() => setSetting(false)} onSave={onSave} />}
    </section>
  );
}

/** What ReBattery shows for them. It moves the stage to Signed up and Live by itself. */
function OnReBattery({ d, error, onEdit }: { d: Dismantler; error: string | null; onEdit: () => void }) {
  const p = d.platform;
  const how = p?.matched_by === "linked" ? "linked by hand" : p?.matched_by === "email" ? "matched by a shared email" : "matched by their web domain";
  const row = (label: string, value: string) => (
    <div className="flex items-center border-b px-5 py-[11px] text-sm last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
      <span className="flex-1" style={{ color: "var(--bt-text-2)" }}>{label}</span>
      <span className="bt-mono font-medium">{value}</span>
    </div>
  );
  return (
    <Card label="On ReBattery">
      <header className="flex items-center border-b px-5 py-4" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="flex-1 text-base font-semibold">On ReBattery</h2>
        <button type="button" onClick={onEdit} className="text-xs font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
          {p ? "Change account" : "Link account"}
        </button>
      </header>
      {p ? (
        <>
          <p className="border-b px-5 py-3 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
            <span className="font-semibold">{p.account_name}</span>
            <span style={{ color: "var(--bt-muted)" }}> · {how}</span>
          </p>
          {row("Signed up", p.signed_up_on ? dayMonth(p.signed_up_on) : "yes")}
          {row("Listed now", String(p.listed))}
          {row("Listed ever", String(p.listed_ever))}
          {row("Sold", String(p.sold))}
          {row("Last listing", p.last_listed_on ? dayMonth(p.last_listed_on) : "none yet")}
        </>
      ) : (
        <p className="px-5 py-4 text-sm" style={{ color: "var(--bt-muted)" }}>
          {d.platform_account_id === "none"
            ? "Marked as having no ReBattery account."
            : "No ReBattery account found. It links by itself when someone here signs up with an email we know, or link it by hand."}
        </p>
      )}
      {error && <p className="px-5 pb-3 text-xs" style={{ color: "var(--bt-amber)" }}>{error}</p>}
    </Card>
  );
}

const FIELD_NAMES: Record<string, string> = {
  stage: "Stage", next_step: "Next step", next_step_due: "Due", platform_account_id: "ReBattery account",
  owner_user_id: "Owner", goal: "Q4 goal", country: "Country", notes: "Notes",
};

/** One line for a history event. */
function eventText(item: Extract<Activity, { kind: "event" }>): string {
  const changes = item.changes as Record<string, [unknown, unknown] | unknown>;
  const pair = (key: string) => (Array.isArray(changes[key]) ? (changes[key] as [unknown, unknown]) : null);
  if (item.event === "created") return "Added to Dismantlers";
  if (item.event === "imported") return "Added from an imported list";
  if (item.event === "email_draft") return `Gmail draft: ${String(changes.subject ?? "")}`;
  const stage = pair("stage");
  if (stage) {
    const note = item.event === "outreach" ? " (outreach started)" : item.event === "simplified" ? " (stages simplified)" : "";
    return `${String(stage[0])} → ${String(stage[1])}${note}`;
  }
  const step = pair("next_step");
  if (step?.[1]) return `Next step: ${String(step[1])}`;
  const fields = Object.keys(changes).map((key) => FIELD_NAMES[key]).filter(Boolean);
  return fields.length ? `Changed ${fields.join(", ").toLowerCase()}` : "Updated";
}

function ActivityCard({ activity }: { activity: Activity[] }) {
  return (
    <Card label="Activity">
      <header className="flex items-center border-b px-5 py-4" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="flex-1 text-base font-semibold">Activity</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>your emails with them, and changes here</span>
      </header>
      {activity.length ? activity.slice(0, 15).map((item, index) => (
        <div key={index} className="grid grid-cols-[70px_1fr] gap-3 border-b px-5 py-[11px] text-sm last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
          <span className="pt-0.5 text-xs" style={{ color: "var(--bt-muted)" }}>{dayMonth(item.at.slice(0, 10))}</span>
          <div className="min-w-0">
            <span className="bt-label !text-[10px]">
              {item.kind === "email" ? (item.outgoing ? "Email sent" : "Email received") : item.event === "email_draft" ? "Draft" : "Change"}
            </span>
            <div className="mt-0.5 truncate">
              {item.kind === "email" ? (item.subject ?? "(no subject)") : eventText(item)}
              {item.kind === "event" && item.actor && <span style={{ color: "var(--bt-muted)" }}> · {item.actor}</span>}
            </div>
          </div>
        </div>
      )) : (
        <p className="px-5 py-4 text-sm" style={{ color: "var(--bt-muted)" }}>Nothing yet.</p>
      )}
    </Card>
  );
}

function Notes({ d, onSave }: { d: Dismantler; onSave: (patch: DismantlerPatch) => Promise<void> }) {
  const [value, setValue] = useState(d.notes ?? "");
  useEffect(() => setValue(d.notes ?? ""), [d.notes]);
  return (
    <Card label="Notes" className="flex flex-col gap-2 px-5 py-[18px]">
      <h2 className="text-base font-semibold">Notes</h2>
      <textarea
        aria-label="Notes"
        rows={4}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => { if (value.trim() !== (d.notes ?? "")) void onSave({ notes: value }); }}
        placeholder="Anything worth remembering: who decides, what they worry about, how they list today"
        className="w-full border px-2.5 py-2 text-[13px] leading-relaxed"
        style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}
      />
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Saved when you click away.</p>
    </Card>
  );
}

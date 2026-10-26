"use client";

import { GROUPS } from "@/lib/dismantlers";
import styles from "./dismantlers.module.css";

/** Same grids as the real list, so nothing jumps when the data arrives. */
export const COLUMNS = "grid-cols-[minmax(0,1.4fr)_100px_minmax(0,1.8fr)_110px_minmax(0,1fr)_90px]";

const surface = { background: "var(--bt-surface)", borderColor: "var(--bt-border)" } as const;

/** One shimmering block. Decorative: the region around it carries the loading text. */
export function Bone({ w, h = 12, pill = false, className = "" }: { w: number | string; h?: number; pill?: boolean; className?: string }) {
  return <span aria-hidden="true" className={`${styles.skeleton} ${pill ? styles.pill : ""} ${className}`} style={{ width: w, height: h }} />;
}

/** Screen-reader loading text; the visible part of the page is skeleton. */
export function LoadingText({ children }: { children: string }) {
  return <span role="status" className="sr-only">{children}</span>;
}

export function StageChipsSkeleton() {
  return (
    <>
      {[58, 66, 76, 48, 60].map((width, index) => (
        <span key={index} className="flex items-center gap-1.5"><Bone w={8} h={8} pill /><Bone w={width} h={12} pill /></span>
      ))}
    </>
  );
}

function RowSkeleton({ widths }: { widths: number[] }) {
  return (
    <div className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-4 py-3 last:border-b-0`} style={{ borderColor: "var(--bt-divider)" }}>
      <div className="flex min-w-0 flex-col gap-1.5"><Bone w={`${widths[0]}%`} h={13} /><Bone w="45%" h={11} /></div>
      <Bone w={64} h={20} pill />
      <div className="flex min-w-0 flex-col gap-1.5"><Bone w={`${widths[1]}%`} h={12} /><Bone w="35%" h={11} /></div>
      <Bone w={64} h={20} pill />
      <Bone w={`${widths[2]}%`} h={12} />
      <Bone w={56} h={12} />
    </div>
  );
}

const ROWS = [[62, 80, 70], [48, 66, 55], [70, 74, 62]];

/** Header row, three group headings and rounded row blocks, as the list lays out. */
export function ListSkeleton() {
  return (
    <div className="overflow-x-auto" data-testid="list-skeleton">
      <div className="flex min-w-[960px] flex-col gap-5">
        <div className={`grid ${COLUMNS} gap-4 rounded-lg px-4 py-2`} style={{ background: "var(--bt-table-head)" }}>
          {[70, 40, 60, 30, 70, 64].map((width, index) => <Bone key={index} w={width} h={11} />)}
        </div>
        {GROUPS.slice(0, 3).map((group, index) => (
          <div key={group} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-2"><Bone w={96} h={13} /><Bone w={16} h={13} /></div>
            <div className="overflow-hidden rounded-xl border" style={surface}>
              {ROWS.slice(0, 3 - index).map((widths, row) => <RowSkeleton key={row} widths={widths} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 shadow-sm" style={surface}>
      <Bone w="70%" h={14} />
      <Bone w="45%" h={11} />
      <div className="border-t pt-2" style={{ borderColor: "var(--bt-divider)" }}><Bone w="90%" h={12} /></div>
      <div className="flex items-center justify-between"><Bone w={60} h={20} pill /><Bone w={72} h={26} /></div>
    </div>
  );
}

/** Five 250px columns like the board, with a few card blocks each. */
export function BoardSkeleton() {
  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-4" data-testid="board-skeleton">
      {[3, 3, 2, 1, 0].map((cards, column) => (
        column === 4 ? (
          <div key={column} className="flex h-[200px] w-11 shrink-0 flex-col items-center gap-2.5 rounded-2xl border py-3" style={{ ...surface, background: "var(--bt-bg)" }}>
            <Bone w={8} h={8} pill /><Bone w={14} h={12} /><Bone w={14} h={70} />
          </div>
        ) : (
          <div key={column} className="flex w-[250px] shrink-0 flex-col rounded-2xl border" style={surface}>
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
              <Bone w={8} h={8} pill /><Bone w={70} h={14} /><span className="flex-1" /><Bone w={16} h={12} />
            </div>
            <div className="flex min-h-[120px] flex-col gap-2 p-2">
              {Array.from({ length: cards }, (_, index) => <CardSkeleton key={index} />)}
            </div>
          </div>
        )
      ))}
    </div>
  );
}

/** Stands in for the ReBattery account facts until they arrive. */
export function PlatformFactsSkeleton() {
  return (
    <>
      <div className="border-b px-5 py-3" style={{ borderColor: "var(--bt-divider)" }}><Bone w="55%" h={14} /></div>
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="flex items-center border-b px-5 py-[13px] last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
          <Bone w={90} h={12} /><span className="flex-1" /><Bone w={40} h={12} />
        </div>
      ))}
    </>
  );
}

function BlockSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-xl border" style={surface}>
      <div className="border-b px-5 py-4" style={{ borderColor: "var(--bt-divider)" }}><Bone w={110} h={16} /></div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5 border-b px-5 py-[13px] last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
          <Bone w={`${85 - index * 12}%`} h={12} /><Bone w="40%" h={10} />
        </div>
      ))}
    </div>
  );
}

/** Detail page body: journey, next-step bar, facts and activity, contacts and notes. */
export function DetailSkeleton() {
  return (
    <main className="flex flex-1 flex-col gap-6 overflow-auto px-8 pb-8 pt-6" aria-busy="true">
      <LoadingText>Loading dismantler…</LoadingText>
      <div className="flex flex-col gap-3.5 rounded-xl border px-5 py-[18px]" style={surface}>
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((index) => <div key={index} className="flex flex-col gap-1.5"><Bone w="100%" h={4} pill /><Bone w="60%" h={13} /></div>)}
        </div>
        <div className="flex items-center gap-3 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}><Bone w="55%" h={14} /><span className="flex-1" /><Bone w={120} h={32} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border px-4 py-3" style={surface}>
        <Bone w={84} h={22} pill /><Bone w="40%" h={16} /><span className="flex-1" /><Bone w={110} h={32} /><Bone w={110} h={32} />
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border" style={surface}>
          <div className="border-b px-5 py-4" style={{ borderColor: "var(--bt-divider)" }}><Bone w={110} h={16} /></div>
          <PlatformFactsSkeleton />
        </div>
        <BlockSkeleton rows={4} />
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <BlockSkeleton rows={2} />
        <div className="flex flex-col gap-2 rounded-xl border px-5 py-[18px]" style={surface}><Bone w={70} h={16} /><Bone w="100%" h={84} /></div>
      </div>
    </main>
  );
}

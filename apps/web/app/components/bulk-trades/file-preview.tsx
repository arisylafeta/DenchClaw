"use client";

import type { BulkTrade } from "@/lib/bulk-trades";
import { isImage, previewType, type TradeFile } from "@/lib/bulk-trade-details";
import { tradeUrl } from "./trade-ui";

export const fileUrl = (trade: BulkTrade, file: TradeFile, view = false) =>
  tradeUrl(trade.id, `/files/${file.id}${view ? "?view=1" : ""}`);

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

/** Image thumbnail, or a badge with the file type. */
export function FileThumb({ trade, file, size = 36 }: { trade: BulkTrade; file: TradeFile; size?: number }) {
  const style = { width: size, height: size, background: "var(--bt-divider)", color: "var(--bt-text-2)" };
  if (isImage(file.file_name)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- private, auth-gated file; no image optimisation
      <img src={fileUrl(trade, file, true)} alt="" loading="lazy" className="shrink-0 rounded-lg object-cover" style={style} />
    );
  }
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-lg text-[11px] font-bold" style={style}>
      {extension(file.file_name)}
    </span>
  );
}

/** Opens PDFs and images in a new tab; other files download. */
export function FileLink({ trade, file, className, children }: {
  trade: BulkTrade;
  file: TradeFile;
  className?: string;
  children: React.ReactNode;
}) {
  const viewable = previewType(file.file_name) !== null;
  return viewable
    ? <a href={fileUrl(trade, file, true)} target="_blank" rel="noreferrer" className={className} title="Open in a new tab">{children}</a>
    : <a href={fileUrl(trade, file)} className={className} title="Download">{children}</a>;
}

"use client";

import { useState } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import type { UserAttachment } from "./attachments";

function Chip({ file }: { file: UserAttachment }) {
  const [broken, setBroken] = useState(false);
  const showThumb = file.image && !broken;
  const Icon = file.image ? ImageIcon : FileText;
  return <span className="flex h-8 max-w-[14rem] min-w-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] py-0.5 pl-0.5 pr-2.5 text-[11px] text-[var(--color-text)]" title={file.path} data-attachment>
    {showThumb
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={`/api/workspace/raw-file?path=${encodeURIComponent(file.path)}`} alt="" loading="lazy" onError={() => setBroken(true)} className="size-7 shrink-0 rounded-md object-cover" />
      : <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[var(--color-text-muted)]"><Icon aria-hidden="true" className="size-3.5" /></span>}
    <span className="min-w-0 truncate">{file.name}</span>
  </span>;
}
/** Small attachment chips shown above the user's bubble. */
export function AttachmentChips({ attachments }: { attachments: readonly UserAttachment[] }) {
  if (!attachments.length) return null;
  return <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5" aria-label="Attachments">{attachments.map((file, index) => <Chip key={`${file.path}-${index}`} file={file} />)}</div>;
}

"use client";

import { useState } from "react";
import { useTableCellExpanded } from "../ui/table-cell";

/**
 * Elegant icon + name link for a related entry. Replaces the legacy
 * "blue-pill" relation chip across the workspace (table cells, detail panel,
 * detail modal) so every relation reference looks the same and reads as a
 * proper link.
 *
 * Why a single component: previously each surface had its own ad-hoc pill
 * markup (different padding, colors, hover, click handling). Visually they
 * were "almost the same" in different places, and they all hid the fact
 * that relations are *navigation* — clicking should open the related
 * entry. Centralizing it here makes the affordance honest (cursor pointer,
 * underline-on-hover, accent text) and removes the pill background that
 * made small companies hard to read.
 *
 * Icon resolution:
 *   1. If `faviconUrl` is provided AND loads, show it (server pre-computes
 *      this from the related entry's first URL field — see
 *      `resolveRelationLabels`).
 *   2. On image error / missing URL, fall back to a single-letter monogram
 *      derived from `label`. This keeps the layout stable and avoids a
 *      second network round-trip for unfaviconable entries (people,
 *      internal records, etc).
 *
 * The component itself renders one item; callers wrap multiple in a
 * flex/wrap container.
 */
export function RelationLink({
	label,
	faviconUrl,
	onClick,
	maxLabelWidth = 200,
}: {
	label: string;
	faviconUrl?: string;
	onClick?: (e: React.MouseEvent) => void;
	/** Pixel cap on the label before truncation. Cells use a smaller cap so
	 * cell-level horizontal overflow doesn't blow out the column. */
	maxLabelWidth?: number;
}) {
	const expanded = useTableCellExpanded();
	const isClickable = !!onClick;
	const Tag = isClickable ? "button" : "span";

	return (
		<Tag
			type={isClickable ? "button" : undefined}
			onClick={onClick}
			title={isClickable ? `Open ${label}` : label}
			className={`inline-flex items-center gap-1.5 max-w-full text-left ${
				isClickable
					? "cursor-pointer hover:underline focus:outline-hidden focus-visible:underline"
					: ""
			}`}
			style={{
				color: isClickable
					? "var(--color-accent)"
					: "var(--color-text)",
				background: "transparent",
				border: "none",
				padding: 0,
				font: "inherit",
			}}
		>
			<RelationIcon faviconUrl={faviconUrl} label={label} />
			<span
				className="truncate"
				style={{ maxWidth: expanded ? undefined : maxLabelWidth }}
			>
				{label}
			</span>
		</Tag>
	);
}

/**
 * 16x16 leading icon. Renders the favicon when one is supplied and loads
 * cleanly; otherwise renders a letter monogram on a muted tile.
 *
 * The image-error fallback is the important bit: Google's s2 favicon
 * service returns a generic "?" tile for unknown domains, but it can also
 * 404 outright on private domains. Without this fallback we'd show a
 * broken-image glyph next to the company name.
 */
function RelationIcon({
	faviconUrl,
	label,
}: {
	faviconUrl?: string;
	label: string;
}) {
	const [imgFailed, setImgFailed] = useState(false);
	const initial = (label?.trim().charAt(0) ?? "?").toUpperCase();
	const showImg = !!faviconUrl && !imgFailed;

	return (
		<span
			aria-hidden="true"
			className="inline-flex items-center justify-center shrink-0 rounded-[3px] overflow-hidden"
			style={{
				width: 16,
				height: 16,
				background: showImg
					? "transparent"
					: "var(--color-surface-hover)",
				border: showImg ? "none" : "1px solid var(--color-border)",
				color: "var(--color-text-muted)",
				fontSize: 9,
				fontWeight: 600,
				lineHeight: 1,
			}}
		>
			{showImg ? (
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={faviconUrl}
					alt=""
					width={16}
					height={16}
					decoding="async"
					loading="lazy"
					onError={() => setImgFailed(true)}
					style={{
						width: 16,
						height: 16,
						objectFit: "contain",
					}}
				/>
			) : (
				initial
			)}
		</span>
	);
}

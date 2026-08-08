"use client";

import { type ActionConfig } from "./action-button";

export type BulkRunState = {
	status: "idle" | "running" | "done";
	running: number;
	succeeded: number;
	failed: number;
	total: number;
};

type BulkActionBarProps = {
	selectedCount: number;
	actions: Array<{ action: ActionConfig; fieldId: string }>;
	onDeselectAll: () => void;
	onBulkAction: (action: ActionConfig, fieldId: string) => void;
	onBulkDelete: () => void;
	bulkRunStates?: Map<string, BulkRunState>;
	/**
	 * Optional bulk-Enrich handler. When provided, an "Enrich" button is
	 * rendered between the action list and Delete. Object tables only pass
	 * this when at least one column on the object has enrichment metadata
	 * (i.e. the operation has something to do); otherwise the button is
	 * hidden so we never show a no-op control.
	 */
	onBulkEnrich?: () => void;
	/** Disables the Enrich button while an enrichment run is already in flight. */
	enrichBusy?: boolean;
};

const VARIANT_COLORS: Record<string, string> = {
	default: "var(--color-text)",
	primary: "#3b82f6",
	destructive: "var(--color-error)",
	success: "#22c55e",
	warning: "#f59e0b",
};

function BulkActionButton({
	action,
	fieldId,
	runState,
	onClick,
}: {
	action: ActionConfig;
	fieldId: string;
	runState?: BulkRunState;
	onClick: () => void;
}) {
	const variant = action.variant ?? "default";
	const color = VARIANT_COLORS[variant] ?? VARIANT_COLORS.default;
	const isRunning = runState?.status === "running";
	const isDone = runState?.status === "done";

	let label = action.label;
	let icon: React.ReactNode = (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<polygon points="5 3 19 12 5 21 5 3" />
		</svg>
	);
	let statusBadge: React.ReactNode = null;
	let buttonColor = color;
	let buttonBg = `color-mix(in srgb, ${color} 8%, transparent)`;
	let buttonBorder = `1px solid color-mix(in srgb, ${color} 20%, transparent)`;

	if (isRunning && runState) {
		label = `${action.label}`;
		icon = (
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
				<path d="M21 12a9 9 0 1 1-6.219-8.56" />
			</svg>
		);
		statusBadge = (
			<span className="text-[10px] font-mono opacity-70 tabular-nums">
				{runState.succeeded + runState.failed}/{runState.total}
			</span>
		);
	} else if (isDone && runState) {
		const allOk = runState.failed === 0;
		if (allOk) {
			icon = (
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			);
			buttonColor = "#22c55e";
			buttonBg = "rgba(34, 197, 94, 0.1)";
			buttonBorder = "1px solid rgba(34, 197, 94, 0.3)";
			label = `${runState.succeeded} done`;
		} else {
			icon = (
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			);
			buttonColor = "#dc2626";
			buttonBg = "rgba(220, 38, 38, 0.1)";
			buttonBorder = "1px solid rgba(220, 38, 38, 0.3)";
			label = `${runState.succeeded} ok, ${runState.failed} failed`;
		}
	}

	return (
		<button
			key={`${fieldId}_${action.id}`}
			type="button"
			onClick={onClick}
			disabled={isRunning}
			className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
			style={{
				background: buttonBg,
				border: buttonBorder,
				color: buttonColor,
				opacity: isRunning ? 0.8 : 1,
				cursor: isRunning ? "not-allowed" : "pointer",
			}}
		>
			{icon}
			<span className="whitespace-nowrap">{label}</span>
			{statusBadge}
		</button>
	);
}

export function BulkActionBar({
	selectedCount,
	actions,
	onDeselectAll,
	onBulkAction,
	onBulkDelete,
	bulkRunStates,
	onBulkEnrich,
	enrichBusy,
}: BulkActionBarProps) {
	if (selectedCount === 0) return null;

	return (
		<div
			className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-2.5 rounded-xl shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-300"
			style={{
				background: "var(--color-surface)",
				border: "1px solid var(--color-border)",
				backdropFilter: "blur(16px)",
				minWidth: 320,
			}}
		>
			<div className="flex items-center gap-2 pr-3" style={{ borderRight: "1px solid var(--color-border)" }}>
				<span
					className="flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold"
					style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
				>
					{selectedCount}
				</span>
				<span className="text-xs font-medium whitespace-nowrap" style={{ color: "var(--color-text-muted)" }}>
					selected
				</span>
				<button
					type="button"
					onClick={onDeselectAll}
					className="text-[11px] underline underline-offset-2 transition-opacity hover:opacity-70"
					style={{ color: "var(--color-text-muted)" }}
				>
					Clear
				</button>
			</div>

			{actions.length > 0 && (
				<div className="flex items-center gap-1.5">
					{actions.map(({ action, fieldId }) => (
						<BulkActionButton
							key={`${fieldId}_${action.id}`}
							action={action}
							fieldId={fieldId}
							runState={bulkRunStates?.get(action.id)}
							onClick={() => onBulkAction(action, fieldId)}
						/>
					))}
				</div>
			)}

			<div
				className="ml-auto pl-3 flex items-center gap-1.5"
				style={{ borderLeft: actions.length > 0 ? "1px solid var(--color-border)" : "none" }}
			>
				{onBulkEnrich && (
					<button
						type="button"
						onClick={onBulkEnrich}
						disabled={enrichBusy}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
						style={{
							background: "color-mix(in srgb, var(--color-accent-fill) 8%, transparent)",
							border: "1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)",
							color: "var(--color-accent)",
							opacity: enrichBusy ? 0.7 : 1,
							cursor: enrichBusy ? "not-allowed" : "pointer",
						}}
						title={
							enrichBusy
								? "Enrichment already in progress"
								: `Enrich the ${selectedCount} selected ${selectedCount === 1 ? "row" : "rows"}`
						}
					>
						{enrichBusy ? (
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								className="animate-spin"
							>
								<path d="M21 12a9 9 0 1 1-6.219-8.56" />
							</svg>
						) : (
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" />
								<path d="M19 19L19.5 20.5L21 21L19.5 21.5L19 23L18.5 21.5L17 21L18.5 20.5L19 19Z" />
							</svg>
						)}
						Enrich
					</button>
				)}
				<button
					type="button"
					onClick={onBulkDelete}
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
					style={{
						background: "rgba(220, 38, 38, 0.08)",
						border: "1px solid rgba(220, 38, 38, 0.2)",
						color: "var(--color-error)",
					}}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
					</svg>
					Delete
				</button>
			</div>
		</div>
	);
}

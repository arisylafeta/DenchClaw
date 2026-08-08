"use client";

import { useEffect, useRef, useCallback, useState } from "react";

type ConfirmDialogProps = {
	open: boolean;
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "default" | "destructive";
	onConfirm: () => void;
	onCancel: () => void;
	loading?: boolean;
};

export function ConfirmDialog({
	open,
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	onConfirm,
	onCancel,
	loading = false,
}: ConfirmDialogProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (open) {
			setTimeout(() => confirmRef.current?.focus(), 50);
		}
	}, [open]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			onCancel();
		}
	}, [onCancel]);

	if (!open) return null;

	const isDestructive = variant === "destructive";

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center"
			onKeyDown={handleKeyDown}
		>
			<div
				className="absolute inset-0 backdrop-blur-sm animate-in fade-in duration-150"
				style={{ background: "rgba(0, 0, 0, 0.4)" }}
				onClick={onCancel}
			/>
			<div
				className="relative w-full max-w-sm mx-4 rounded-xl p-6 shadow-2xl animate-in zoom-in-95 fade-in duration-200"
				style={{
					background: "var(--color-surface)",
					border: "1px solid var(--color-border)",
				}}
			>
				<div className="flex items-start gap-3 mb-4">
					<div
						className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
						style={{
							background: isDestructive ? "rgba(220, 38, 38, 0.1)" : "rgba(59, 130, 246, 0.1)",
						}}
					>
						{isDestructive ? (
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
								<line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
							</svg>
						) : (
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
							</svg>
						)}
					</div>
					<div className="flex-1 min-w-0">
						<h3 className="text-sm font-semibold mb-1" style={{ color: "var(--color-text)" }}>
							{title}
						</h3>
						<p className="text-sm leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
							{message}
						</p>
					</div>
				</div>
				<div className="flex items-center justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
						style={{
							background: "transparent",
							border: "1px solid var(--color-border)",
							color: "var(--color-text-muted)",
						}}
					>
						{cancelLabel}
					</button>
					<button
						ref={confirmRef}
						type="button"
						onClick={onConfirm}
						disabled={loading}
						className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
						style={{
							background: isDestructive ? "#dc2626" : "var(--color-accent-fill)",
							border: "none",
							color: "var(--color-accent-foreground)",
							opacity: loading ? 0.7 : 1,
						}}
					>
						{loading && (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
								<path d="M21 12a9 9 0 1 1-6.219-8.56" />
							</svg>
						)}
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

type ConfirmState = {
	open: boolean;
	title: string;
	message: string;
	confirmLabel?: string;
	variant?: "default" | "destructive";
	onConfirm: () => void;
};

/**
 * Hook for managing confirm dialog state.
 */
export function useConfirmDialog() {
	const [state, setState] = useState<ConfirmState | null>(null);

	const confirm = useCallback((opts: Omit<ConfirmState, "open">) => {
		setState({ ...opts, open: true });
	}, []);

	const close = useCallback(() => {
		setState(null);
	}, []);

	return { state, confirm, close };
}

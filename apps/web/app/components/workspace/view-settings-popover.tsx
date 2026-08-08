"use client";

import { useState, useRef, useEffect } from "react";
import type { ViewType, ViewTypeSettings, CalendarMode, TimelineZoom } from "@/lib/object-filters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Field = {
	id: string;
	name: string;
	type: string;
	enum_values?: string[];
};

type ViewSettingsPopoverProps = {
	viewType: ViewType;
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (settings: ViewTypeSettings) => void;
	/** Optional description shown at the top of the popover. */
	description?: string;
	/** Currently selected display field name. */
	displayField?: string;
	/** Fields eligible to be the display field. */
	displayFieldCandidates?: Field[];
	/** Called when the user selects a new display field. */
	onDisplayFieldChange?: (name: string) => void;
	/** Whether the display field is currently being updated on the server. */
	updatingDisplayField?: boolean;
	/** Column visibility map (fieldId -> visible). When provided, a Columns section is rendered. */
	columnVisibility?: Record<string, boolean>;
	/** Called when the user toggles a column's visibility. */
	onColumnVisibilityChange?: (next: Record<string, boolean>) => void;
	/** Whether the first column is frozen/sticky. */
	stickyFirstColumn?: boolean;
	/** Called when the user toggles the freeze first column option. */
	onStickyFirstColumnChange?: (next: boolean) => void;
};

// ---------------------------------------------------------------------------
// Field picker dropdown
// ---------------------------------------------------------------------------

function FieldSelect({
	label,
	value,
	onChange,
	fields,
	filterType,
	allowEmpty,
}: {
	label: string;
	value: string | undefined;
	onChange: (value: string | undefined) => void;
	fields: Field[];
	filterType?: string | string[];
	allowEmpty?: boolean;
}) {
	const types = filterType
		? Array.isArray(filterType) ? filterType : [filterType]
		: null;
	const filtered = types ? fields.filter((f) => types.includes(f.type)) : fields;

	return (
		<div className="flex flex-col gap-1">
			<label className="text-[10px] font-medium" style={{ color: "var(--color-text-muted)" }}>
				{label}
			</label>
			<select
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value || undefined)}
				className="text-[12px] rounded-md border px-2 py-1.5 bg-transparent"
				style={{
					borderColor: "var(--color-border)",
					color: "var(--color-text)",
					background: "var(--color-surface)",
				}}
			>
				{allowEmpty && <option value="">None</option>}
				{filtered.length === 0 && (
					<option value="" disabled>No matching fields</option>
				)}
				{filtered.map((f) => (
					<option key={f.id} value={f.name}>{f.name}</option>
				))}
			</select>
		</div>
	);
}

function ModeSelect<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<label className="text-[10px] font-medium" style={{ color: "var(--color-text-muted)" }}>
				{label}
			</label>
			<div
				className="flex rounded-md border overflow-hidden"
				style={{ borderColor: "var(--color-border)" }}
			>
				{options.map((opt) => (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className="text-[11px] px-2.5 py-1 flex-1 transition-colors capitalize"
						style={{
							background: opt.value === value ? "var(--color-accent-fill)" : "var(--color-surface)",
							color: opt.value === value ? "var(--color-accent-foreground)" : "var(--color-text-muted)",
						}}
					>
						{opt.label}
					</button>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Settings panels per view type
// ---------------------------------------------------------------------------

function KanbanSettings({
	settings,
	fields,
	onSettingsChange,
}: {
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (s: ViewTypeSettings) => void;
}) {
	return (
		<FieldSelect
			label="Group by field"
			value={settings.kanbanField}
			onChange={(v) => onSettingsChange({ ...settings, kanbanField: v })}
			fields={fields}
			filterType="enum"
		/>
	);
}

function CalendarSettings({
	settings,
	fields,
	onSettingsChange,
}: {
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (s: ViewTypeSettings) => void;
}) {
	return (
		<>
			<FieldSelect
				label="Date field"
				value={settings.calendarDateField}
				onChange={(v) => onSettingsChange({ ...settings, calendarDateField: v })}
				fields={fields}
				filterType="date"
			/>
			<FieldSelect
				label="End date field (optional)"
				value={settings.calendarEndDateField}
				onChange={(v) => onSettingsChange({ ...settings, calendarEndDateField: v })}
				fields={fields}
				filterType="date"
				allowEmpty
			/>
			<ModeSelect<CalendarMode>
				label="Default view"
				value={settings.calendarMode ?? "month"}
				options={[
					{ value: "day", label: "Day" },
					{ value: "week", label: "Week" },
					{ value: "month", label: "Month" },
					{ value: "year", label: "Year" },
				]}
				onChange={(v) => onSettingsChange({ ...settings, calendarMode: v })}
			/>
		</>
	);
}

function TimelineSettings({
	settings,
	fields,
	onSettingsChange,
}: {
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (s: ViewTypeSettings) => void;
}) {
	return (
		<>
			<FieldSelect
				label="Start date field"
				value={settings.timelineStartField}
				onChange={(v) => onSettingsChange({ ...settings, timelineStartField: v })}
				fields={fields}
				filterType="date"
			/>
			<FieldSelect
				label="End date field"
				value={settings.timelineEndField}
				onChange={(v) => onSettingsChange({ ...settings, timelineEndField: v })}
				fields={fields}
				filterType="date"
				allowEmpty
			/>
			<FieldSelect
				label="Group by (optional)"
				value={settings.timelineGroupField}
				onChange={(v) => onSettingsChange({ ...settings, timelineGroupField: v })}
				fields={fields}
				filterType="enum"
				allowEmpty
			/>
			<ModeSelect<TimelineZoom>
				label="Default zoom"
				value={settings.timelineZoom ?? "week"}
				options={[
					{ value: "day", label: "Day" },
					{ value: "week", label: "Week" },
					{ value: "month", label: "Month" },
					{ value: "quarter", label: "Quarter" },
				]}
				onChange={(v) => onSettingsChange({ ...settings, timelineZoom: v })}
			/>
		</>
	);
}

function GallerySettings({
	settings,
	fields,
	onSettingsChange,
}: {
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (s: ViewTypeSettings) => void;
}) {
	return (
		<>
			<FieldSelect
				label="Title field"
				value={settings.galleryTitleField}
				onChange={(v) => onSettingsChange({ ...settings, galleryTitleField: v })}
				fields={fields}
				filterType="text"
			/>
			<FieldSelect
				label="Cover field (optional)"
				value={settings.galleryCoverField}
				onChange={(v) => onSettingsChange({ ...settings, galleryCoverField: v })}
				fields={fields}
				allowEmpty
			/>
		</>
	);
}

function ListSettings({
	settings,
	fields,
	onSettingsChange,
}: {
	settings: ViewTypeSettings;
	fields: Field[];
	onSettingsChange: (s: ViewTypeSettings) => void;
}) {
	return (
		<>
			<FieldSelect
				label="Title field"
				value={settings.listTitleField}
				onChange={(v) => onSettingsChange({ ...settings, listTitleField: v })}
				fields={fields}
				filterType="text"
			/>
			<FieldSelect
				label="Subtitle field (optional)"
				value={settings.listSubtitleField}
				onChange={(v) => onSettingsChange({ ...settings, listSubtitleField: v })}
				fields={fields}
				filterType={["text", "email", "richtext"]}
				allowEmpty
			/>
		</>
	);
}

// ---------------------------------------------------------------------------
// Main popover
// ---------------------------------------------------------------------------

function GearIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="text-[10px] font-semibold uppercase tracking-wider"
			style={{ color: "var(--color-text-muted)" }}
		>
			{children}
		</div>
	);
}

function DescriptionSection({ description }: { description: string }) {
	return (
		<div className="flex flex-col gap-1">
			<SectionLabel>About</SectionLabel>
			<p
				className="text-[12px] leading-snug"
				style={{ color: "var(--color-text)" }}
			>
				{description}
			</p>
		</div>
	);
}

function DisplayFieldSection({
	displayField,
	candidates,
	onChange,
	updating,
}: {
	displayField: string | undefined;
	candidates: Field[];
	onChange: (name: string) => void;
	updating: boolean;
}) {
	return (
		<div className="flex flex-col gap-1">
			<SectionLabel>Display field</SectionLabel>
			<div className="flex items-center gap-1.5">
				<select
					value={displayField ?? ""}
					onChange={(e) => onChange(e.target.value)}
					disabled={updating}
					className="text-[12px] rounded-md border px-2 py-1.5 flex-1 outline-none cursor-pointer"
					style={{
						borderColor: "var(--color-border)",
						color: "var(--color-text)",
						background: "var(--color-surface)",
						opacity: updating ? 0.5 : 1,
					}}
				>
					{candidates.map((f) => (
						<option key={f.id} value={f.name}>
							{f.name}
						</option>
					))}
				</select>
				{updating && (
					<div
						className="w-3 h-3 border border-t-transparent rounded-full animate-spin shrink-0"
						style={{ borderColor: "var(--color-text-muted)" }}
					/>
				)}
			</div>
		</div>
	);
}

function ColumnsSection({
	fields,
	columnVisibility,
	onColumnVisibilityChange,
	stickyFirstColumn,
	onStickyFirstColumnChange,
}: {
	fields: Field[];
	columnVisibility: Record<string, boolean>;
	onColumnVisibilityChange: (next: Record<string, boolean>) => void;
	stickyFirstColumn?: boolean;
	onStickyFirstColumnChange?: (next: boolean) => void;
}) {
	const toggle = (fieldId: string) => {
		const current = columnVisibility[fieldId] !== false;
		onColumnVisibilityChange({ ...columnVisibility, [fieldId]: !current });
	};

	return (
		<div className="flex flex-col gap-1.5">
			<SectionLabel>Columns</SectionLabel>
			{onStickyFirstColumnChange && (
				<label
					className="flex items-center gap-2 text-[12px] cursor-pointer"
					style={{ color: "var(--color-text)" }}
				>
					<input
						type="checkbox"
						checked={Boolean(stickyFirstColumn)}
						onChange={(e) => onStickyFirstColumnChange(e.target.checked)}
						className="cursor-pointer"
					/>
					Freeze first column
				</label>
			)}
			<div
				className="flex flex-col gap-1 max-h-48 overflow-y-auto rounded-md border p-1.5"
				style={{ borderColor: "var(--color-border)" }}
			>
				{fields.length === 0 ? (
					<div
						className="text-[11px] px-1 py-0.5"
						style={{ color: "var(--color-text-muted)" }}
					>
						No columns
					</div>
				) : (
					fields.map((field) => {
						const visible = columnVisibility[field.id] !== false;
						return (
							<label
								key={field.id}
								className="flex items-center gap-2 text-[12px] cursor-pointer px-1 py-0.5 rounded hover:bg-[var(--color-surface-hover)]"
								style={{ color: "var(--color-text)" }}
							>
								<input
									type="checkbox"
									checked={visible}
									onChange={() => toggle(field.id)}
									className="cursor-pointer"
								/>
								<span className="truncate">{field.name}</span>
							</label>
						);
					})
				)}
			</div>
		</div>
	);
}

export function ViewSettingsPopover({
	viewType,
	settings,
	fields,
	onSettingsChange,
	description,
	displayField,
	displayFieldCandidates,
	onDisplayFieldChange,
	updatingDisplayField,
	columnVisibility,
	onColumnVisibilityChange,
	stickyFirstColumn,
	onStickyFirstColumnChange,
}: ViewSettingsPopoverProps) {
	const [open, setOpen] = useState(false);
	const popoverRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {return;}
		const handler = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const hasDescription = Boolean(description && description.trim());
	const hasDisplayField =
		Boolean(displayFieldCandidates && displayFieldCandidates.length > 0 && onDisplayFieldChange);
	const hasColumns = Boolean(onColumnVisibilityChange && viewType === "table");
	const effectiveColumnVisibility = columnVisibility ?? {};

	const viewTypeHasSettings = viewType !== "table";

	const hasAnyContent =
		hasDescription || hasDisplayField || hasColumns || viewTypeHasSettings;

	if (!hasAnyContent) {return null;}

	const panelTitle: Record<ViewType, string> = {
		table: "Table Settings",
		kanban: "Board Settings",
		calendar: "Calendar Settings",
		timeline: "Timeline Settings",
		gallery: "Gallery Settings",
		list: "List Settings",
	};

	return (
		<div className="relative" ref={popoverRef}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
				style={{ color: "var(--color-text-muted)" }}
				title="View settings"
				aria-label="View settings"
			>
				<GearIcon />
			</button>

			{open && (
				<div
					className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg p-3 min-w-[220px] sm:min-w-[260px] max-w-[calc(100vw-2rem)] flex flex-col gap-3"
					style={{
						borderColor: "var(--color-border)",
						background: "var(--color-surface)",
						boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
					}}
				>
					<div className="text-[11px] font-semibold" style={{ color: "var(--color-text)" }}>
						{panelTitle[viewType]}
					</div>

					{hasDescription && <DescriptionSection description={description!} />}

					{hasDisplayField && (
						<DisplayFieldSection
							displayField={displayField}
							candidates={displayFieldCandidates!}
							onChange={onDisplayFieldChange!}
							updating={Boolean(updatingDisplayField)}
						/>
					)}

					{viewType === "kanban" && (
						<KanbanSettings settings={settings} fields={fields} onSettingsChange={onSettingsChange} />
					)}
					{viewType === "calendar" && (
						<CalendarSettings settings={settings} fields={fields} onSettingsChange={onSettingsChange} />
					)}
					{viewType === "timeline" && (
						<TimelineSettings settings={settings} fields={fields} onSettingsChange={onSettingsChange} />
					)}
					{viewType === "gallery" && (
						<GallerySettings settings={settings} fields={fields} onSettingsChange={onSettingsChange} />
					)}
					{viewType === "list" && (
						<ListSettings settings={settings} fields={fields} onSettingsChange={onSettingsChange} />
					)}

					{hasColumns && (
						<ColumnsSection
							fields={fields}
							columnVisibility={effectiveColumnVisibility}
							onColumnVisibilityChange={onColumnVisibilityChange!}
							stickyFirstColumn={stickyFirstColumn}
							onStickyFirstColumnChange={onStickyFirstColumnChange}
						/>
					)}
				</div>
			)}
		</div>
	);
}

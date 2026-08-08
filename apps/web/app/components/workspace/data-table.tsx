"use client";

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
	useReactTable,
	getCoreRowModel,
	getSortedRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	flexRender,
	type ColumnDef,
	type SortingState,
	type ColumnFiltersState,
	type VisibilityState,
	type ColumnSizingState,
	type Table,
	type Row,
	type OnChangeFn,
	type PaginationState,
} from "@tanstack/react-table";
import {
	DndContext,
	closestCenter,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	horizontalListSortingStrategy,
	useSortable,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { rankItem } from "@tanstack/match-sorter-utils";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuCheckboxItem,
} from "../ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { UrlFavicon } from "./url-favicon";
import type { TableCellSelectionState, TableSelectionPoint } from "@/lib/table-selection";

/* ─── Types ─── */

export type { ColumnSizingState } from "@tanstack/react-table";

export type RowAction<TData> = {
	label: string;
	onClick?: (row: TData) => void;
	icon?: React.ReactNode;
	variant?: "default" | "destructive";
};

export type DataTableProps<TData, TValue> = {
	columns: ColumnDef<TData, TValue>[];
	data: TData[];
	loading?: boolean;
	// search
	searchPlaceholder?: string;
	enableGlobalFilter?: boolean;
	// sorting
	enableSorting?: boolean;
	// row selection
	enableRowSelection?: boolean;
	rowSelection?: Record<string, boolean>;
	onRowSelectionChange?: OnChangeFn<Record<string, boolean>>;
	enableCellSelection?: boolean;
	cellSelection?: TableCellSelectionState | null;
	onCellSelectionChange?: (selection: TableCellSelectionState | null) => void;
	bulkActions?: React.ReactNode;
	// column features
	enableColumnReordering?: boolean;
	onColumnReorder?: (newOrder: string[]) => void;
	initialColumnVisibility?: VisibilityState;
	onColumnVisibilityChanged?: (visibility: VisibilityState) => void;
	initialColumnSizing?: ColumnSizingState;
	onColumnSizingChange?: (sizing: ColumnSizingState) => void;
	// pagination
	pageSize?: number;
	// actions
	onRefresh?: () => void;
	onAdd?: () => void;
	addButtonLabel?: string;
	onRowClick?: (row: TData, index: number) => void;
	getFirstDataColumnFaviconUrl?: (row: Row<TData>, table: Table<TData>) => string | null | undefined;
	rowActions?: (row: TData) => RowAction<TData>[];
	rowActionsHeader?: React.ReactNode;
	// toolbar
	toolbarExtra?: React.ReactNode;
	title?: string;
	titleIcon?: React.ReactNode;
	// sticky
	stickyFirstColumn?: boolean;
	// active row highlight
	activeRowId?: string;
	getRowId?: (row: TData) => string;
	// server-side pagination
	serverPagination?: {
		totalCount: number;
		page: number;
		pageSize: number;
		onPageChange: (page: number) => void;
		onPageSizeChange: (size: number) => void;
	};
	// server-side search callback (replaces client-side fuzzy filter)
	onServerSearch?: (query: string) => void;
	/**
	 * Fires whenever the table's internal sorting state changes (header
	 * click, column-menu Sort ascending / descending). The new sorting
	 * state is the resolved value, never the TanStack updater fn. The
	 * client-side sorted row model still keeps the visible page in
	 * order; consumers use this hook to mirror sort to the server so
	 * pagination stays consistent across pages.
	 */
	onSortChange?: (sorting: SortingState) => void;
	/** When true, column header click is disabled (no sort-on-click). */
	disableHeaderClickSort?: boolean;
	// When true, the built-in toolbar (search, columns, refresh, +Add) is not rendered.
	// The parent is expected to provide equivalent controls externally.
	hideToolbar?: boolean;
	// Controlled global filter. When provided, overrides the internal state.
	globalFilter?: string;
	onGlobalFilterChange?: (value: string) => void;
	// Controlled sticky-first-column. When provided, overrides the internal state.
	stickyFirstColumnValue?: boolean;
	onStickyFirstColumnChange?: (value: boolean) => void;
};

/* ─── Fuzzy filter ─── */

function fuzzyFilter(
	row: Row<unknown>,
	columnId: string,
	filterValue: string,
) {
	const result = rankItem(row.getValue(columnId), filterValue);
	return result.passed;
}

const UTILITY_COLUMN_IDS = new Set(["__rownum", "select", "actions", "__add_column"]);

function isEditableEventTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='button']"));
}

function resolveCellRange(
	selection: TableCellSelectionState | null,
	columnIds: string[],
	rowCount: number,
) {
	if (!selection || rowCount === 0 || columnIds.length === 0) {
		return null;
	}
	const anchorCol = columnIds.indexOf(selection.anchor.columnId);
	const focusCol = columnIds.indexOf(selection.focus.columnId);
	if (anchorCol < 0 || focusCol < 0) {
		return null;
	}
	const rowStart = Math.max(0, Math.min(selection.anchor.rowIndex, selection.focus.rowIndex));
	const rowEnd = Math.min(rowCount - 1, Math.max(selection.anchor.rowIndex, selection.focus.rowIndex));
	const colStart = Math.min(anchorCol, focusCol);
	const colEnd = Math.max(anchorCol, focusCol);
	return { rowStart, rowEnd, colStart, colEnd };
}

/* ─── Sortable header cell (DnD) ─── */

function SortableHeader({
	id,
	children,
	style,
	className,
}: {
	id: string;
	children: (dragListeners: ReturnType<typeof useSortable>["listeners"]) => React.ReactNode;
	style?: React.CSSProperties;
	className?: string;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	const dragStyle: React.CSSProperties = {
		...style,
		transform: CSS.Translate.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<th
			ref={setNodeRef}
			style={dragStyle}
			className={className}
			{...attributes}
		>
			{children(listeners)}
		</th>
	);
}

/* ─── Sort icon ─── */

function SortIcon({ direction }: { direction: "asc" | "desc" | false }) {
	if (!direction) {
		return (
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
				<path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" />
			</svg>
		);
	}
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			{direction === "asc" ? <path d="m5 12 7-7 7 7" /> : <path d="m19 12-7 7-7-7" />}
		</svg>
	);
}

/* ─── Main component ─── */

export function DataTable<TData, TValue>({
	columns,
	data,
	loading = false,
	searchPlaceholder = "Search...",
	enableGlobalFilter = true,
	enableSorting = true,
	enableRowSelection = false,
	rowSelection: externalRowSelection,
	onRowSelectionChange,
	enableCellSelection = false,
	cellSelection: externalCellSelection,
	onCellSelectionChange,
	bulkActions,
	enableColumnReordering = false,
	onColumnReorder,
	initialColumnVisibility,
	onColumnVisibilityChanged,
	initialColumnSizing,
	onColumnSizingChange,
	pageSize: defaultPageSize = 100,
	onRefresh,
	onAdd,
	addButtonLabel = "+ Add",
	onRowClick,
	getFirstDataColumnFaviconUrl,
	rowActions,
	rowActionsHeader,
	toolbarExtra,
	title,
	titleIcon,
	stickyFirstColumn: stickyFirstProp = true,
	activeRowId,
	getRowId,
	serverPagination,
	onServerSearch,
	onSortChange,
	disableHeaderClickSort = false,
	hideToolbar = false,
	globalFilter: globalFilterProp,
	onGlobalFilterChange,
	stickyFirstColumnValue,
	onStickyFirstColumnChange,
}: DataTableProps<TData, TValue>) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const [internalGlobalFilter, setInternalGlobalFilter] = useState("");
	const globalFilter = globalFilterProp !== undefined ? globalFilterProp : internalGlobalFilter;
	const setGlobalFilter = useCallback(
		(v: string | ((prev: string) => string)) => {
			const resolved = typeof v === "function" ? v(globalFilter) : v;
			if (onGlobalFilterChange) {
				onGlobalFilterChange(resolved);
			} else {
				setInternalGlobalFilter(resolved);
			}
		},
		[globalFilter, onGlobalFilterChange],
	);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialColumnVisibility ?? {});
	const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(initialColumnSizing ?? {});
	// Sync column visibility when the prop changes (e.g. loading a saved view)
	useEffect(() => {
		setColumnVisibility(initialColumnVisibility ?? {});
	}, [initialColumnVisibility]);
	useEffect(() => {
		setColumnSizing(initialColumnSizing ?? {});
	}, [initialColumnSizing]);
	const [internalRowSelection, setInternalRowSelection] = useState<Record<string, boolean>>({});
	const [internalCellSelection, setInternalCellSelection] = useState<TableCellSelectionState | null>(null);
	const [internalStickyFirstColumn, setInternalStickyFirstColumn] = useState(stickyFirstProp);
	const stickyFirstColumn =
		stickyFirstColumnValue !== undefined ? stickyFirstColumnValue : internalStickyFirstColumn;
	const setStickyFirstColumn = useCallback(
		(next: boolean | ((prev: boolean) => boolean)) => {
			const resolved = typeof next === "function" ? next(stickyFirstColumn) : next;
			if (onStickyFirstColumnChange) {
				onStickyFirstColumnChange(resolved);
			} else {
				setInternalStickyFirstColumn(resolved);
			}
		},
		[stickyFirstColumn, onStickyFirstColumnChange],
	);
	const [isScrolled, setIsScrolled] = useState(false);
	const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: defaultPageSize });
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	const rowSelectionState = externalRowSelection !== undefined ? externalRowSelection : internalRowSelection;
	const cellSelectionState = externalCellSelection !== undefined ? externalCellSelection : internalCellSelection;
	const setCellSelection = useCallback((next: TableCellSelectionState | null) => {
		if (externalCellSelection === undefined) {
			setInternalCellSelection(next);
		}
		onCellSelectionChange?.(next);
	}, [externalCellSelection, onCellSelectionChange]);

	// Extract column ID from ColumnDef
	const getColumnId = useCallback((c: ColumnDef<TData, TValue>): string => {
		if ("id" in c && typeof c.id === "string") {return c.id;}
		if ("accessorKey" in c && typeof c.accessorKey === "string") {return c.accessorKey;}
		return "";
	}, []);

	// Column order for DnD — include "__rownum"/"select" at start and "actions" at end
	// so TanStack doesn't push them to the end of the table
	const buildColumnOrder = useCallback(
		(dataCols: ColumnDef<TData, TValue>[]) => {
			const dataOrder = dataCols.map(getColumnId);
			const order: string[] = [];
			order.push("__rownum");
			if (enableRowSelection) {order.push("select");}
			order.push(...dataOrder);
			if (rowActions) {order.push("actions");}
			return order;
		},
		[getColumnId, enableRowSelection, rowActions],
	);

	const [columnOrder, setColumnOrder] = useState<string[]>(() =>
		buildColumnOrder(columns),
	);

	const FIXED_COL_IDS = new Set(["__rownum", "select", "actions", "__add_column"]);

	// Reconcile column order when columns change (preserves user DnD ordering)
	useEffect(() => {
		setColumnOrder((prevOrder) => {
			const freshOrder = buildColumnOrder(columns);
			const freshSet = new Set(freshOrder);
			const freshDataIds = new Set(freshOrder.filter((id) => !FIXED_COL_IDS.has(id)));
			const prevDataOrder = prevOrder.filter((id) => !FIXED_COL_IDS.has(id) && freshDataIds.has(id));
			const existingDataSet = new Set(prevDataOrder);
			for (const id of freshDataIds) {
				if (!existingDataSet.has(id)) prevDataOrder.push(id);
			}
			const result: string[] = [];
			if (freshSet.has("__rownum")) result.push("__rownum");
			if (freshSet.has("select")) result.push("select");
			result.push(...prevDataOrder);
			if (freshSet.has("actions")) result.push("actions");
			if (freshSet.has("__add_column")) result.push("__add_column");
			if (result.length === prevOrder.length && result.every((id, i) => id === prevOrder[i])) return prevOrder;
			return result;
		});
	}, [columns, buildColumnOrder]);

	// DnD sensors
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (over && active.id !== over.id) {
				setColumnOrder((old) => {
					const oldIndex = old.indexOf(active.id as string);
					const newIndex = old.indexOf(over.id as string);
					const newOrder = arrayMove(old, oldIndex, newIndex);
					onColumnReorder?.(newOrder);
					return newOrder;
				});
			}
		},
		[onColumnReorder],
	);

	// Scroll tracking for sticky column shadow.
	// Coalesces via rAF + ref comparison so a continuous scroll doesn't
	// trigger a setState (and thus a tbody re-render) per pixel.
	const isScrolledRef = useRef(false);
	const scrollRafRef = useRef<number | null>(null);
	const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
		const next = e.currentTarget.scrollLeft > 0;
		if (next === isScrolledRef.current) {return;}
		isScrolledRef.current = next;
		if (scrollRafRef.current != null) {return;}
		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = null;
			setIsScrolled(isScrolledRef.current);
		});
	}, []);
	useEffect(() => () => {
		if (scrollRafRef.current != null) {cancelAnimationFrame(scrollRafRef.current);}
	}, []);

	// Build row number column — always first, non-sortable, non-hideable.
	// Memoized so the column definition has a stable identity across renders;
	// otherwise `allColumns` (and therefore the entire TanStack table tree)
	// would rebuild on every render — including a row-selection click.
	const serverPaginationPage = serverPagination?.page;
	const serverPaginationPageSize = serverPagination?.pageSize;
	const rownumColumn = useMemo<ColumnDef<TData>>(() => ({
		id: "__rownum",
		header: () => (
			<span
				className="text-[10px] tabular-nums opacity-50"
				style={{ color: "var(--color-text-muted)" }}
			>
				#
			</span>
		),
		cell: ({ row }) => {
			const baseIdx = serverPaginationPage != null && serverPaginationPageSize != null
				? (serverPaginationPage - 1) * serverPaginationPageSize
				: 0;
			return (
				<span
					className="text-[11px] tabular-nums"
					style={{ color: "var(--color-text-muted)", opacity: 0.55 }}
				>
					{baseIdx + row.index + 1}
				</span>
			);
		},
		size: 48,
		minSize: 48,
		enableSorting: false,
		enableHiding: false,
		enableResizing: false,
	}), [serverPaginationPage, serverPaginationPageSize]);

	// Build selection column. Memoized for stable identity across renders.
	const selectionColumn = useMemo<ColumnDef<TData> | null>(() => enableRowSelection
		? {
				id: "select",
				header: ({ table }) => (
					<input
						type="checkbox"
						checked={table.getIsAllPageRowsSelected()}
						onChange={table.getToggleAllPageRowsSelectedHandler()}
						className="w-3.5 h-3.5 rounded accent-[var(--color-accent)] cursor-pointer"
					/>
				),
				cell: ({ row }) => (
					<input
						type="checkbox"
						checked={row.getIsSelected()}
						onChange={row.getToggleSelectedHandler()}
						onClick={(e) => e.stopPropagation()}
						className="w-3.5 h-3.5 rounded accent-[var(--color-accent)] cursor-pointer"
					/>
				),
				size: 40,
				minSize: 40,
				enableSorting: false,
				enableHiding: false,
			}
		: null, [enableRowSelection]);

	// Build actions column — use refs so the column definition (and
	// critically its `header` function reference) stays stable across
	// re-renders.  When the function reference changes, TanStack's
	// flexRender treats it as a new component and remounts the header,
	// destroying popover state.
	const rowActionsRef = useRef(rowActions);
	rowActionsRef.current = rowActions;
	const rowActionsHeaderRef = useRef(rowActionsHeader);
	rowActionsHeaderRef.current = rowActionsHeader;

	const hasRowActions = !!rowActions;
	const actionsColumn: ColumnDef<TData> | null = useMemo(() => {
		if (!hasRowActions) return null;
		return {
					id: "actions",
					header: () => rowActionsHeaderRef.current ?? null,
					cell: ({ row }: { row: { original: TData } }) => (
						<RowActionsMenu
							row={row.original}
							actions={rowActionsRef.current?.(row.original) ?? []}
						/>
					),
					size: 48,
					minSize: 48,
					enableSorting: false,
					enableHiding: false,
					enableResizing: false,
				};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasRowActions]);

	const allColumns = useMemo(() => {
		const cols: ColumnDef<TData, TValue>[] = [];
		cols.push(rownumColumn as ColumnDef<TData, TValue>);
		if (selectionColumn) {cols.push(selectionColumn as ColumnDef<TData, TValue>);}
		cols.push(...columns);
		if (actionsColumn) {cols.push(actionsColumn as ColumnDef<TData, TValue>);}
		return cols;
	}, [columns, selectionColumn, actionsColumn, rownumColumn]);

	// Server-side pagination state derived from props. Memoized so the
	// table state object identity is stable across renders that don't
	// touch pagination.
	const serverPaginationState = useMemo(
		() => serverPagination
			? { pageIndex: serverPagination.page - 1, pageSize: serverPagination.pageSize }
			: undefined,
		[serverPagination?.page, serverPagination?.pageSize], // eslint-disable-line react-hooks/exhaustive-deps
	);

	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const table = useReactTable({
		data,
		columns: allColumns,
		state: {
			sorting,
			globalFilter,
			columnFilters,
			columnVisibility,
			columnSizing,
			rowSelection: rowSelectionState,
			columnOrder: enableColumnReordering ? columnOrder : undefined,
			pagination: serverPaginationState ?? pagination,
		},
		onSortingChange: (updater) => {
			const next = typeof updater === "function" ? updater(sorting) : updater;
			setSorting(next);
			onSortChange?.(next);
		},
		onGlobalFilterChange: setGlobalFilter,
		onColumnFiltersChange: setColumnFilters,
		onColumnVisibilityChange: (updater) => {
			const next = typeof updater === "function" ? updater(columnVisibility) : updater;
			setColumnVisibility(next);
			onColumnVisibilityChanged?.(next);
		},
		onColumnSizingChange: (updater) => {
			const next = typeof updater === "function" ? updater(columnSizing) : updater;
			setColumnSizing(next);
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			resizeTimerRef.current = setTimeout(() => onColumnSizingChange?.(next), 500);
		},
		onRowSelectionChange: (updater) => {
			if (onRowSelectionChange) {
				onRowSelectionChange(updater);
			} else {
				setInternalRowSelection(updater);
			}
		},
		onPaginationChange: serverPagination
			? (updater) => {
				const newVal = typeof updater === "function"
					? updater(serverPaginationState!)
					: updater;
				if (newVal.pageSize !== serverPagination.pageSize) {
					serverPagination.onPageSizeChange(newVal.pageSize);
				} else if (newVal.pageIndex !== serverPagination.page - 1) {
					serverPagination.onPageChange(newVal.pageIndex + 1);
				}
			}
			: setPagination,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
		getFilteredRowModel: serverPagination ? undefined : getFilteredRowModel(),
		getPaginationRowModel: serverPagination ? undefined : getPaginationRowModel(),
		...(serverPagination ? {
			manualPagination: true,
			pageCount: Math.ceil(serverPagination.totalCount / serverPagination.pageSize),
		} : {}),
		enableRowSelection,
		enableSorting,
		globalFilterFn: fuzzyFilter,
		columnResizeMode: "onChange",
		defaultColumn: { minSize: 150 },
	});

	const selectedCount = Object.keys(rowSelectionState).filter((k) => rowSelectionState[k]).length;
	const visibleColumns = table.getVisibleFlatColumns().filter((c) => c.id !== "__rownum" && c.id !== "select" && c.id !== "actions" && c.id !== "__add_column");
	const visibleDataColumnIds = table.getVisibleLeafColumns()
		.map((column) => column.id)
		.filter((id) => !UTILITY_COLUMN_IDS.has(id));
	const visibleRowCount = table.getRowModel().rows.length;
	const cellSelectionEnabled = enableCellSelection && visibleRowCount > 0 && visibleDataColumnIds.length > 0;
	// Stable items array for dnd-kit's SortableContext so the dnd
	// context isn't reset on every render.
	const sortableHeaderIds = useMemo(
		() => columnOrder.filter((id) => !FIXED_COL_IDS.has(id)),
		[columnOrder], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// Column sizes as CSS variables for performant resize (TanStack recommended approach).
	// Only th elements reference these vars; td widths are inherited via table-layout:fixed.
	// Depend on `columnSizing` (the actual sizes) instead of `columnSizingInfo` (a fresh
	// object on every state change) so this doesn't recompute on selection/sort/etc.
	const columnSizingState = table.getState().columnSizing;
	const isResizingColumn = !!table.getState().columnSizingInfo.isResizingColumn;
	const columnSizeVars = useMemo(() => {
		const headers = table.getFlatHeaders();
		const vars: Record<string, number> = {};
		for (const header of headers) {
			vars[`--header-${header.id}-size`] = header.getSize();
			vars[`--col-${header.column.id}-size`] = header.column.getSize();
		}
		return vars;
	}, [columnSizingState, isResizingColumn, columnVisibility, columnOrder]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!cellSelectionState) {
			return;
		}
		const range = resolveCellRange(cellSelectionState, visibleDataColumnIds, visibleRowCount);
		if (!range) {
			setCellSelection(null);
		}
	}, [cellSelectionState, setCellSelection, visibleDataColumnIds, visibleRowCount]);

	useEffect(() => {
		if (!cellSelectionState) {
			return;
		}
		scrollContainerRef.current
			?.querySelector("[data-dt-cell-active='true']")
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [cellSelectionState]);

	const selectedColumnsByRow = useMemo(() => {
		const range = resolveCellRange(cellSelectionState, visibleDataColumnIds, visibleRowCount);
		const byRow = new Map<number, string[]>();
		if (!range) {
			return byRow;
		}
		const selectedColumnIds = visibleDataColumnIds.slice(range.colStart, range.colEnd + 1);
		for (let rowIdx = range.rowStart; rowIdx <= range.rowEnd; rowIdx++) {
			byRow.set(rowIdx, selectedColumnIds);
		}
		return byRow;
	}, [cellSelectionState, visibleDataColumnIds, visibleRowCount]);

	const handleCellMouseDown = useCallback((rowIndex: number, columnId: string, event: React.MouseEvent<HTMLTableCellElement>) => {
		if (!cellSelectionEnabled || event.button !== 0 || isEditableEventTarget(event.target)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		scrollContainerRef.current?.focus({ preventScroll: true });
		const nextPoint = { rowIndex, columnId };
		setCellSelection(event.shiftKey && cellSelectionState
			? { anchor: cellSelectionState.anchor, focus: nextPoint }
			: { anchor: nextPoint, focus: nextPoint });
	}, [cellSelectionEnabled, cellSelectionState, setCellSelection]);

	const handleCellKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!cellSelectionEnabled || isEditableEventTarget(event.target)) {
			return;
		}
		if (event.key === "Escape" && cellSelectionState) {
			event.preventDefault();
			setCellSelection(null);
			return;
		}
		const deltas: Record<string, { row: number; col: number }> = {
			ArrowUp: { row: -1, col: 0 },
			ArrowDown: { row: 1, col: 0 },
			ArrowLeft: { row: 0, col: -1 },
			ArrowRight: { row: 0, col: 1 },
		};
		const delta = deltas[event.key];
		if (!delta) {
			return;
		}
		event.preventDefault();
		const current = cellSelectionState?.focus ?? { rowIndex: 0, columnId: visibleDataColumnIds[0] };
		const currentColIndex = Math.max(0, visibleDataColumnIds.indexOf(current.columnId));
		const nextPoint: TableSelectionPoint = {
			rowIndex: Math.min(Math.max(current.rowIndex + delta.row, 0), visibleRowCount - 1),
			columnId: visibleDataColumnIds[
				Math.min(Math.max(currentColIndex + delta.col, 0), visibleDataColumnIds.length - 1)
			],
		};
		setCellSelection({
			anchor: event.shiftKey && cellSelectionState ? cellSelectionState.anchor : nextPoint,
			focus: nextPoint,
		});
	}, [cellSelectionEnabled, cellSelectionState, setCellSelection, visibleDataColumnIds, visibleRowCount]);

	// ─── Render ───

	return (
		<div className="w-full h-full flex flex-col overflow-hidden" style={{ overscrollBehavior: "contain" }}>
			{/* Toolbar */}
			{!hideToolbar && (
			<div
				className="flex items-center gap-3 px-3 py-2 shrink-0 flex-wrap backdrop-blur-md"
				style={{ background: "var(--color-glass)", borderBottom: "1px solid var(--color-border)" }}
			>
				{title && (
					<div className="flex items-center gap-2 mr-1">
						{titleIcon}
						<span className="text-xs font-semibold" style={{ color: "var(--color-text)" }}>
							{title}
						</span>
					</div>
				)}

				{/* Search */}
				{enableGlobalFilter && (
					<div
						className="flex min-w-[140px] max-w-[260px] flex-[1_1_180px] items-center gap-2 h-8 px-3 backdrop-blur-sm rounded-full focus-within:ring-2 focus-within:ring-(--color-accent)/30 transition-shadow shadow-[0_0_21px_0_rgba(0,0,0,0.05)]"
						style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
							<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
						</svg>
						<input
							type="text"
							value={globalFilter}
							onChange={(e) => {
								setGlobalFilter(e.target.value);
								onServerSearch?.(e.target.value);
							}}
							placeholder={searchPlaceholder}
							className="w-full h-full text-xs bg-transparent outline-none border-0 p-0"
							style={{ color: "var(--color-text)" }}
						/>
						{globalFilter && (
							<button
								type="button"
								onClick={() => { setGlobalFilter(""); onServerSearch?.(""); }}
								className="shrink-0 h-5 w-5 rounded-full flex items-center justify-center cursor-pointer transition-colors"
								style={{ color: "var(--color-text-muted)" }}
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
							</button>
						)}
					</div>
				)}

				{/* Bulk actions */}
				{selectedCount > 0 && bulkActions && (
					<div className="flex items-center gap-2">
						<span className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
							{selectedCount} selected
						</span>
						{bulkActions}
					</div>
				)}

				<div className="ml-auto flex min-w-0 max-w-full flex-[1_1_220px] flex-wrap items-center justify-end gap-2">
					{toolbarExtra}

					{/* Columns menu */}
					<DropdownMenu>
						<DropdownMenuTrigger
							className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs cursor-pointer transition-colors backdrop-blur-sm shadow-[0_0_21px_0_rgba(0,0,0,0.05)] outline-none focus:outline-none"
							style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" />
							</svg>
							Columns
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" sideOffset={6}>
							<DropdownMenuCheckboxItem
								checked={stickyFirstColumn}
								onSelect={() => setStickyFirstColumn((v) => !v)}
							>
								Freeze first column
							</DropdownMenuCheckboxItem>
							<DropdownMenuSeparator />
							{visibleColumns.length === 0 ? (
								<div className="px-2 py-1.5 text-xs opacity-50">No toggleable columns</div>
							) : (
								table.getAllLeafColumns()
									.filter((c) => c.id !== "__rownum" && c.id !== "select" && c.id !== "actions" && c.id !== "__add_column" && c.getCanHide())
									.map((column) => (
										<DropdownMenuCheckboxItem
											key={column.id}
											checked={column.getIsVisible()}
											onSelect={() => column.toggleVisibility(!column.getIsVisible())}
										>
											{typeof column.columnDef.header === "string"
												? column.columnDef.header
												: String((column.columnDef.meta as Record<string, string> | undefined)?.label ?? column.id)}
										</DropdownMenuCheckboxItem>
									))
							)}
						</DropdownMenuContent>
					</DropdownMenu>

					{/* Refresh button */}
					{onRefresh && (
						<button
							type="button"
							onClick={onRefresh}
							className="h-8 w-8 rounded-full flex items-center justify-center cursor-pointer transition-colors backdrop-blur-sm shadow-[0_0_21px_0_rgba(0,0,0,0.05)]"
							style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text-muted)" }}
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21h5v-5" /></svg>
						</button>
					)}

					{/* Add button */}
					{onAdd && (
						<button
							type="button"
							onClick={onAdd}
							className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors shadow-[0_0_21px_0_rgba(0,0,0,0.05)]"
							style={{
								background: "var(--color-accent-fill)",
								color: "var(--color-accent-foreground)",
							}}
						>
							{addButtonLabel}
						</button>
					)}
				</div>
			</div>
			)}

			{/* Table */}
			<div
				ref={scrollContainerRef}
				className="overflow-auto flex-1 min-h-0 max-h-full relative"
				onScroll={handleScroll}
				onKeyDown={handleCellKeyDown}
				tabIndex={cellSelectionEnabled ? 0 : undefined}
				style={{ overscrollBehavior: "contain" }}
			>
				{loading ? (
					<LoadingSkeleton columnCount={allColumns.length} />
				) : (
					<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
						<table
							className="w-full caption-bottom text-sm"
							style={{ ...columnSizeVars, tableLayout: "fixed", minWidth: table.getTotalSize() }}
						>
							<thead className="[&_tr]:border-b sticky top-0 z-30" style={{ background: "var(--color-surface)" }}>
								{table.getHeaderGroups().map((headerGroup) => (
									<tr
										key={headerGroup.id}
										style={{ borderColor: "var(--color-border)" }}
										className="border-b-2 backdrop-blur-sm"
									>
										<SortableContext items={sortableHeaderIds} strategy={horizontalListSortingStrategy}>
											{headerGroup.headers.map((header, colIdx) => {
												// Layout: [__rownum, select?, ...data, actions?]
												const firstDataIdx = 1 + (enableRowSelection ? 1 : 0);
												const isRownumCol = header.id === "__rownum";
												const isFirstData = colIdx === firstDataIdx;
												const isSticky = stickyFirstColumn && isFirstData;
												const isSelectCol = header.id === "select";
												const isActionsCol = header.id === "actions";
												const isAddCol = header.id === "__add_column";
												const isRightSticky = isActionsCol || isAddCol;
												const canSort = header.column.getCanSort();
												const isSorted = header.column.getIsSorted();
												const isLastCol = colIdx === headerGroup.headers.length - 1;

												const headerStyle: React.CSSProperties = {
													background: "var(--color-surface)",
													position: "sticky",
													top: 0,
													zIndex: isRightSticky ? 32 : isSticky || isSelectCol ? 31 : 30,
													...(isSticky ? {
														left: enableRowSelection ? 40 : 0,
														boxShadow: isScrolled ? "4px 0 12px -2px rgba(0,0,0,0.15), 2px 0 4px -1px rgba(0,0,0,0.08)" : "none",
													} : {}),
													...(isSelectCol ? { left: 0, position: "sticky", zIndex: 31, width: 40 } : {}),
											...(isRightSticky ? { right: 0, position: "sticky", zIndex: 32 } : {}),
													width: `calc(var(--header-${header.id}-size) * 1px)`,
												};

												const content = header.isPlaceholder
													? null
													: flexRender(header.column.columnDef.header, header.getContext());

												const thClassName = cn(
													"h-11 text-left align-middle font-medium text-[12px] whitespace-nowrap p-0 group select-none relative box-border",
													isRownumCol && "text-right",
													!isLastCol && "border-r",
													isSticky && isScrolled && "border-r-2!",
												);

												const innerClassName = cn(
													"flex items-center gap-1.5 h-full transition-colors",
													isRownumCol ? "px-3 justify-end" : "px-4",
													canSort && "cursor-pointer hover:bg-[var(--color-surface-hover)]",
													isSorted && "bg-[var(--color-surface-hover)]",
												);

											const resizeHandle = !isSelectCol && !isAddCol && !isRownumCol && header.column.getCanResize() ? (
												<div
													data-resize-handle
													onMouseDown={header.getResizeHandler()}
													onTouchStart={header.getResizeHandler()}
													onDoubleClick={() => header.column.resetSize()}
													onClick={(e) => e.stopPropagation()}
													className={cn(
														"dt-resize-handle",
														header.column.getIsResizing() && "dt-resize-active",
													)}
												/>
											) : null;

											if (enableColumnReordering && !isSelectCol && !isActionsCol && !isAddCol && !isRownumCol) {
												return (
													<SortableHeader
														key={header.id}
														id={header.id}
														style={headerStyle}
														className={thClassName}
													>
														{(dragListeners) => (
															<>
																<span
																	className={innerClassName}
																	onClick={canSort && !disableHeaderClickSort ? header.column.getToggleSortingHandler() : undefined}
																	style={{ color: "var(--color-text-muted)", cursor: "grab" }}
																	{...dragListeners}
																>
																	{content}
																	{canSort && <SortIcon direction={isSorted} />}
																</span>
																{resizeHandle}
																{isSticky && isScrolled && (
																	<div className="absolute top-0 right-0 bottom-0 w-4 translate-x-full pointer-events-none bg-linear-to-r from-black/4 to-transparent z-100" />
																)}
															</>
														)}
													</SortableHeader>
												);
											}

											return (
												<th
													key={header.id}
													style={{
														...headerStyle,
														borderColor: "var(--color-border)",
													}}
													className={thClassName}
												>
													<span
														className={innerClassName}
														onClick={canSort && !disableHeaderClickSort ? header.column.getToggleSortingHandler() : undefined}
														style={{ color: "var(--color-text-muted)" }}
													>
														{content}
														{canSort && <SortIcon direction={isSorted} />}
													</span>
													{resizeHandle}
													{isSticky && isScrolled && (
														<div className="absolute top-0 right-0 bottom-0 w-4 translate-x-full pointer-events-none bg-linear-to-r from-black/4 to-transparent z-100" />
													)}
												</th>
											);
											})}
										</SortableContext>
									</tr>
								))}
							</thead>
							{data.length === 0 ? (
								<EmptyTableBody
									columnCount={table.getVisibleLeafColumns().length}
									isFiltered={Boolean(globalFilter)}
								/>
							) : (
								<DataTableBody
									table={table}
									activeRowId={activeRowId}
									getRowId={getRowId}
									enableRowSelection={enableRowSelection}
									stickyFirstColumn={stickyFirstColumn}
									isScrolled={isScrolled}
									onRowClick={onRowClick}
									getFirstDataColumnFaviconUrl={getFirstDataColumnFaviconUrl}
									selectedColumnsByRow={selectedColumnsByRow}
									activeCell={cellSelectionState?.focus ?? null}
									onCellMouseDown={handleCellMouseDown}
								/>
							)}
						</table>
					</DndContext>
				)}
			</div>

			{/* Pagination footer */}
			{!loading && data.length > 0 && (
				<div
					className="flex items-center justify-between px-3 py-1 text-[11px] shrink-0 backdrop-blur-xl"
					style={{
						borderTop: "1px solid var(--color-border)",
						color: "var(--color-text-muted)",
						background: "var(--color-glass)",
					}}
				>
					<span className="tabular-nums">
						{serverPagination
							? `${(serverPagination.page - 1) * serverPagination.pageSize + 1}–${Math.min(serverPagination.page * serverPagination.pageSize, serverPagination.totalCount)} / ${serverPagination.totalCount}`
							: `${table.getRowModel().rows.length} / ${data.length}`}
						{selectedCount > 0 && ` · ${selectedCount} selected`}
					</span>
					<div className="flex items-center gap-2">
						<select
							value={serverPagination ? serverPagination.pageSize : pagination.pageSize}
							onChange={(e) => {
								const newSize = Number(e.target.value);
								if (serverPagination) {
									serverPagination.onPageSizeChange(newSize);
								} else {
									setPagination((p) => ({ ...p, pageSize: newSize, pageIndex: 0 }));
								}
							}}
							className="h-6 px-1.5 py-0 rounded-md text-[11px] outline-none transition-colors cursor-pointer"
							style={{
								background: "var(--color-surface)",
								color: "var(--color-text)",
								border: "1px solid var(--color-border)",
							}}
							title="Rows per page"
						>
							{[20, 50, 100, 250, 500].map((size) => (
								<option key={size} value={size}>{size}/page</option>
							))}
						</select>
						<span className="tabular-nums min-w-[48px] text-center">
							{serverPagination ? serverPagination.page : pagination.pageIndex + 1}/{table.getPageCount()}
						</span>
						<div className="flex gap-0.5">
							{serverPagination ? (
								<>
									<PaginationButton onClick={() => serverPagination.onPageChange(1)} disabled={serverPagination.page <= 1} label="&laquo;" />
									<PaginationButton onClick={() => serverPagination.onPageChange(serverPagination.page - 1)} disabled={serverPagination.page <= 1} label="&lsaquo;" />
									<PaginationButton onClick={() => serverPagination.onPageChange(serverPagination.page + 1)} disabled={serverPagination.page >= Math.ceil(serverPagination.totalCount / serverPagination.pageSize)} label="&rsaquo;" />
									<PaginationButton onClick={() => serverPagination.onPageChange(Math.ceil(serverPagination.totalCount / serverPagination.pageSize))} disabled={serverPagination.page >= Math.ceil(serverPagination.totalCount / serverPagination.pageSize)} label="&raquo;" />
								</>
							) : (
								<>
									<PaginationButton onClick={() => setPagination((p) => ({ ...p, pageIndex: 0 }))} disabled={!table.getCanPreviousPage()} label="&laquo;" />
									<PaginationButton onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} label="&lsaquo;" />
									<PaginationButton onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} label="&rsaquo;" />
									<PaginationButton onClick={() => setPagination((p) => ({ ...p, pageIndex: table.getPageCount() - 1 }))} disabled={!table.getCanNextPage()} label="&raquo;" />
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/* ─── Memoized Table Row & Body ───
 *
 * The big perf win lives here. Previously the entire <tbody> re-rendered on
 * every parent state change (selection, scroll, hover, sort) because the only
 * memo on `DataTableBody` skipped renders ONLY during column resize. We now
 * memoize at the row level so a single checkbox click re-renders just the
 * toggled row instead of all 100+ rows.
 */

// biome-ignore lint/suspicious/noExplicitAny: generic row component used with React.memo
type TableRowProps = {
	row: Row<any>;
	rowIdx: number;
	isSelected: boolean;
	isActive: boolean;
	enableRowSelection: boolean;
	stickyFirstColumn: boolean;
	isScrolled: boolean;
	onRowClick?: (row: any, index: number) => void;
	firstColumnFaviconUrl: string | null | undefined;
	selectedCellColumnIds: string;
	activeCellColumnId: string | null;
	onCellMouseDown?: (rowIndex: number, columnId: string, event: React.MouseEvent<HTMLTableCellElement>) => void;
	/** Stable string key encoding visible column IDs in order. When this
	 * changes (column add/remove/reorder/visibility) the row re-renders. */
	cellLayoutKey: string;
};

function TableRowInner({
	row,
	rowIdx,
	isSelected,
	isActive,
	enableRowSelection,
	stickyFirstColumn,
	isScrolled,
	onRowClick,
	firstColumnFaviconUrl,
	selectedCellColumnIds,
	activeCellColumnId,
	onCellMouseDown,
}: TableRowProps) {
	const visibleCells = row.getVisibleCells();
	const firstDataIdx = 1 + (enableRowSelection ? 1 : 0);
	const altBg = rowIdx % 2 === 0 ? "var(--color-surface)" : "var(--color-bg)";
	const baseBg = isActive || isSelected ? "var(--color-accent-light)" : altBg;
	const stickyBg = baseBg;
	const selectedCellColumns = useMemo(
		() => new Set(selectedCellColumnIds ? selectedCellColumnIds.split("|") : []),
		[selectedCellColumnIds],
	);

	const handleClick = useCallback(() => {
		onRowClick?.(row.original, rowIdx);
	}, [onRowClick, row.original, rowIdx]);

	const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLTableRowElement>) => {
		if (!isSelected && !isActive) {
			(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
		}
	}, [isSelected, isActive]);

	const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLTableRowElement>) => {
		if (!isSelected && !isActive) {
			(e.currentTarget as HTMLElement).style.background = altBg;
		}
	}, [isSelected, isActive, altBg]);

	return (
		<tr
			data-state={isSelected ? "selected" : isActive ? "active" : undefined}
			className={cn(
				"border-b transition-colors duration-100 group/row",
				onRowClick && "cursor-pointer",
				isSelected && "data-[state=selected]:bg-(--color-accent-light)",
			)}
			style={{
				borderColor: isActive ? "var(--color-accent)" : "var(--color-border)",
				background: baseBg,
			}}
			onClick={handleClick}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			{visibleCells.map((cell, colIdx) => {
				const isRownumCol = cell.column.id === "__rownum";
				const isFirstData = colIdx === firstDataIdx;
				const isSticky = stickyFirstColumn && isFirstData;
				const isSelectCol = cell.column.id === "select";
				const isActionsCol = cell.column.id === "actions";
				const isAddCol = cell.column.id === "__add_column";
				const isDataCell = !isRownumCol && !isSelectCol && !isActionsCol && !isAddCol;
				const isRightSticky = isActionsCol || isAddCol;
				const isLastCol = colIdx === visibleCells.length - 1;
				const cellFaviconUrl = isFirstData && !isSelectCol ? firstColumnFaviconUrl : undefined;
				const isCellSelected = isDataCell && selectedCellColumns.has(cell.column.id);
				const isCellActive = isDataCell && activeCellColumnId === cell.column.id;
				const stickyShadow = isSticky && isScrolled
					? "4px 0 12px -2px rgba(0,0,0,0.12), 2px 0 4px -1px rgba(0,0,0,0.06)"
					: "";
				const selectionShadow = isCellActive
					? "inset 0 0 0 2px var(--color-accent)"
					: isCellSelected
						? "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent)"
						: "";

				const cellStyle: React.CSSProperties = {
					borderColor: "var(--color-border)",
					...(isCellSelected
						? { background: "color-mix(in srgb, var(--color-accent-fill) 10%, var(--color-surface))" }
						: {}),
					...((stickyShadow || selectionShadow) ? { boxShadow: [stickyShadow, selectionShadow].filter(Boolean).join(", ") } : {}),
					...(isSticky
						? {
								position: "sticky" as const,
								left: enableRowSelection ? 40 : 0,
								zIndex: 2,
								background: isCellSelected ? "color-mix(in srgb, var(--color-accent-fill) 10%, var(--color-surface))" : stickyBg,
							}
						: {}),
					...(isSelectCol
						? {
								position: "sticky" as const,
								left: 0,
								zIndex: 2,
								background: stickyBg,
								width: 40,
							}
						: {}),
					...(isRightSticky
						? {
								position: "sticky" as const,
								right: 0,
								zIndex: 2,
								background: stickyBg,
							}
						: {}),
				};

				return (
					<td
						key={cell.id}
						data-dt-cell-active={isCellActive ? "true" : undefined}
						data-row-index={isDataCell ? rowIdx : undefined}
						data-column-id={isDataCell ? cell.column.id : undefined}
						className={cn(
							"align-middle whitespace-nowrap text-[13px] border-b transition-colors box-border",
							isRownumCol
								? "px-3 py-3 text-right"
								: isSelectCol
									? "px-3 py-3"
									: "px-4 py-3",
							!isLastCol && "border-r",
							isSticky && isScrolled && "border-r-2!",
							isDataCell && "cursor-cell select-none",
						)}
						style={cellStyle}
						aria-selected={isCellSelected || undefined}
						onMouseDown={(event) => {
							if (isRownumCol && enableRowSelection && !isEditableEventTarget(event.target)) {
								event.preventDefault();
								event.stopPropagation();
								row.toggleSelected(!row.getIsSelected());
								return;
							}
							if (isDataCell) {
								onCellMouseDown?.(rowIdx, cell.column.id, event);
							}
						}}
						onClick={(event) => {
							if (isRownumCol || isDataCell) {
								event.stopPropagation();
							}
						}}
					>
						<div className="overflow-hidden">
							{cellFaviconUrl ? (
								<div className="flex min-w-0 items-center gap-2">
									<span className="pointer-events-none shrink-0">
										<UrlFavicon src={cellFaviconUrl} />
									</span>
									<div className="min-w-0 flex-1 overflow-hidden">
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
									</div>
								</div>
							) : (
								flexRender(cell.column.columnDef.cell, cell.getContext())
							)}
						</div>
						{isSticky && isScrolled && (
							<div className="absolute top-0 right-0 bottom-0 w-4 translate-x-full pointer-events-none bg-linear-to-r from-black/4 to-transparent z-100" />
						)}
					</td>
				);
			})}
		</tr>
	);
}

/** Custom equality: skip re-render unless something the row actually
 * displays changed. The `row` reference itself is fresh on every TanStack
 * render so we explicitly ignore it and compare semantic primitives instead. */
const TableRow = React.memo(TableRowInner, (prev, next) => {
	return (
		prev.row.original === next.row.original &&
		prev.rowIdx === next.rowIdx &&
		prev.isSelected === next.isSelected &&
		prev.isActive === next.isActive &&
		prev.enableRowSelection === next.enableRowSelection &&
		prev.stickyFirstColumn === next.stickyFirstColumn &&
		prev.isScrolled === next.isScrolled &&
		prev.onRowClick === next.onRowClick &&
		prev.firstColumnFaviconUrl === next.firstColumnFaviconUrl &&
		prev.selectedCellColumnIds === next.selectedCellColumnIds &&
		prev.activeCellColumnId === next.activeCellColumnId &&
		prev.onCellMouseDown === next.onCellMouseDown &&
		prev.cellLayoutKey === next.cellLayoutKey
	);
});

// biome-ignore lint/suspicious/noExplicitAny: generic body component used with React.memo
type DataTableBodyProps = {
	table: Table<any>;
	activeRowId?: string;
	getRowId?: (row: any) => string;
	enableRowSelection: boolean;
	stickyFirstColumn: boolean;
	isScrolled: boolean;
	onRowClick?: (row: any, index: number) => void;
	getFirstDataColumnFaviconUrl?: (row: Row<any>, table: Table<any>) => string | null | undefined;
	selectedColumnsByRow: Map<number, string[]>;
	activeCell: TableSelectionPoint | null;
	onCellMouseDown?: (rowIndex: number, columnId: string, event: React.MouseEvent<HTMLTableCellElement>) => void;
};

function DataTableBodyInner({
	table,
	activeRowId,
	getRowId,
	enableRowSelection,
	stickyFirstColumn,
	isScrolled,
	onRowClick,
	getFirstDataColumnFaviconUrl,
	selectedColumnsByRow,
	activeCell,
	onCellMouseDown,
}: DataTableBodyProps) {
	// Encode visible column layout as a stable string. When columns are
	// added/removed/reordered/hidden, this changes and rows re-render.
	// Column SIZE changes don't need to invalidate rows — sizes are applied
	// via CSS variables on <th> elements and <td> widths inherit via
	// table-layout:fixed.
	const cellLayoutKey = table.getVisibleLeafColumns().map((c) => c.id).join("|");

	return (
		<tbody className="[&_tr:last-child]:border-0">
			{table.getRowModel().rows.map((row, rowIdx) => {
				const isSelected = row.getIsSelected();
				const isActive = activeRowId != null && getRowId != null && getRowId(row.original) === activeRowId;
				const firstColumnFaviconUrl = getFirstDataColumnFaviconUrl?.(row, table) ?? undefined;
				const selectedCellColumnIds = selectedColumnsByRow.get(rowIdx)?.join("|") ?? "";
				return (
					<TableRow
						key={row.id}
						row={row}
						rowIdx={rowIdx}
						isSelected={isSelected}
						isActive={isActive}
						enableRowSelection={enableRowSelection}
						stickyFirstColumn={stickyFirstColumn}
						isScrolled={isScrolled}
						onRowClick={onRowClick}
						firstColumnFaviconUrl={firstColumnFaviconUrl}
						selectedCellColumnIds={selectedCellColumnIds}
						activeCellColumnId={activeCell?.rowIndex === rowIdx ? activeCell.columnId : null}
						onCellMouseDown={onCellMouseDown}
						cellLayoutKey={cellLayoutKey}
					/>
				);
			})}
		</tbody>
	);
}

/** Skip re-rendering the body shell during column resize (sizes flow via
 * CSS variables on <th>; rows don't need to react). For all other changes
 * the body re-renders, but per-row memoization above prevents the
 * expensive cell work from running for unchanged rows. */
const DataTableBody = React.memo(DataTableBodyInner, (prev, next) => {
	const isResizing = !!next.table.getState().columnSizingInfo.isResizingColumn;
	if (isResizing && prev.table.options.data === next.table.options.data) {
		return true;
	}
	return false;
});

/** Empty-state body. Rendered in place of `<DataTableBody/>` when there are
 * no rows. Lives inside the same `<table>` so the column headers (including
 * the "+ Add Column" affordance and sort/reorder controls) stay visible and
 * reachable from the empty state — instead of swapping the entire table out
 * for a centered "No data" message, which strands the user with no way to
 * configure their schema or add their first entry.
 *
 * The inner content is `position: sticky; left: 0` with `inline-flex` so it
 * shrink-wraps to its content size and anchors to the left edge of the
 * visible scroll container. Without this, a `<td colSpan>` row spans the
 * full table width — which can be much larger than the viewport for wide
 * schemas — and the centered content would render off-screen. Sticky-left
 * keeps the message reachable regardless of how wide the table is. */
function EmptyTableBody({
	columnCount,
	isFiltered,
}: {
	columnCount: number;
	isFiltered: boolean;
}) {
	const safeColSpan = Math.max(columnCount, 1);
	return (
		<tbody>
			<tr>
				<td colSpan={safeColSpan} className="p-0 border-0">
					<div
						className="flex flex-col items-center gap-4 py-24 px-12"
						style={{ position: "sticky", left: 0, display: "inline-flex" }}
					>
						<div
							className="rounded-full p-4 mb-2 backdrop-blur-sm"
							style={{
								background: "var(--color-glass)",
								border: "1px solid var(--color-border)",
								boxShadow: "var(--shadow-sm)",
							}}
						>
							<svg
								width="32"
								height="32"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								style={{ color: "var(--color-text-muted)" }}
							>
								<circle cx="11" cy="11" r="8" />
								<path d="m21 21-4.3-4.3" />
							</svg>
						</div>
						<div className="text-center">
							<h3
								className="text-base font-semibold mb-1"
								style={{ color: "var(--color-text)" }}
							>
								No results found
							</h3>
							<p
								className="text-sm max-w-xs"
								style={{ color: "var(--color-text-muted)" }}
							>
								{isFiltered
									? "Try adjusting your search or filter criteria."
									: "No data available yet. Create your first entry to get started."}
							</p>
						</div>
					</div>
				</td>
			</tr>
		</tbody>
	);
}

/* ─── Sub-components ─── */

function PaginationButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="h-6 w-6 rounded-md flex items-center justify-center text-[11px] disabled:opacity-30 cursor-pointer transition-colors"
			style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
			// biome-ignore lint: using html entity label
			dangerouslySetInnerHTML={{ __html: label }}
		/>
	);
}

function RowActionsMenu<TData>({ row, actions }: { row: TData; actions: RowAction<TData>[] }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="p-1 rounded-md cursor-pointer"
				style={{ color: "var(--color-text-muted)" }}
				onClick={(e) => e.stopPropagation()}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" sideOffset={4}>
				{actions.map((action, i) => (
					<DropdownMenuItem
						key={i}
						variant={action.variant === "destructive" ? "destructive" : "default"}
						onSelect={() => action.onClick?.(row)}
					>
						{action.icon}
						{action.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function LoadingSkeleton({ columnCount }: { columnCount: number }) {
	const widths = ["w-full", "w-3/4", "w-5/6", "w-2/3"];
	return (
		<div className="w-full">
			{/* Skeleton header */}
			<div className="flex gap-0 border-b-2" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
				{Array.from({ length: Math.min(columnCount, 6) }).map((_col, j) => (
					<div key={j} className="flex-1 h-11 px-4 flex items-center" style={{ borderRight: j < Math.min(columnCount, 6) - 1 ? "1px solid var(--color-border)" : "none" }}>
						<div
							className="h-3 w-16 rounded animate-pulse"
							style={{ background: "var(--color-surface-hover)", animationDelay: `${j * 50}ms`, animationDuration: "1.5s" }}
						/>
					</div>
				))}
			</div>
			{/* Skeleton rows */}
			{Array.from({ length: 15 }).map((_, i) => (
				<div
					key={i}
					className="flex gap-0 border-b"
					style={{ borderColor: "var(--color-border)" }}
				>
					{Array.from({ length: Math.min(columnCount, 6) }).map((_col, j) => (
						<div
							key={j}
							className="flex-1 px-3 py-2.5 flex items-center"
							style={{ borderRight: j < Math.min(columnCount, 6) - 1 ? "1px solid var(--color-border)" : "none" }}
						>
							<div
								className={cn("h-3.5 rounded animate-pulse", widths[(i + j) % widths.length])}
								style={{
									background: "var(--color-surface-hover)",
									animationDelay: `${(i * 50) + (j * 30)}ms`,
									animationDuration: "1.5s",
								}}
							/>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

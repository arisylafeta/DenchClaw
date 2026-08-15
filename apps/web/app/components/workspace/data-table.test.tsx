// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./data-table";

type Row = {
	id: string;
	name: string;
	email: string;
};

const rows: Row[] = [
	{ id: "1", name: "Ada", email: "ada@example.com" },
	{ id: "2", name: "Grace", email: "grace@example.com" },
];

const columns: ColumnDef<Row>[] = [
	{ id: "name", accessorKey: "name", header: "Name" },
	{ id: "email", accessorKey: "email", header: "Email" },
];

describe("DataTable cell selection", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("selects cells and moves the active cell with arrow keys", () => {
		const onCellSelectionChange = vi.fn();
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableCellSelection
				onCellSelectionChange={onCellSelectionChange}
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const firstCell = screen.getByText("Ada").closest("td");
		expect(firstCell).not.toBeNull();
		fireEvent.mouseDown(firstCell!);

		expect(onCellSelectionChange).toHaveBeenLastCalledWith({
			anchor: { rowIndex: 0, columnId: "name" },
			focus: { rowIndex: 0, columnId: "name" },
		});
		expect(firstCell).toHaveAttribute("aria-selected", "true");

		const tableScroller = firstCell!.closest("div[tabindex='0']");
		expect(tableScroller).not.toBeNull();
		fireEvent.keyDown(tableScroller!, { key: "ArrowRight" });

		expect(onCellSelectionChange).toHaveBeenLastCalledWith({
			anchor: { rowIndex: 0, columnId: "email" },
			focus: { rowIndex: 0, columnId: "email" },
		});
		expect(screen.getByText("ada@example.com").closest("td")).toHaveAttribute("data-dt-cell-active", "true");
	});

	it("extends a selected range with shift-arrow navigation", () => {
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableCellSelection
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const firstCell = screen.getByText("Ada").closest("td");
		fireEvent.mouseDown(firstCell!);
		const tableScroller = firstCell!.closest("div[tabindex='0']");
		fireEvent.keyDown(tableScroller!, { key: "ArrowRight" });
		fireEvent.keyDown(tableScroller!, { key: "ArrowDown", shiftKey: true });

		expect(screen.getByText("ada@example.com").closest("td")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("grace@example.com").closest("td")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Grace").closest("td")).not.toHaveAttribute("aria-selected");
	});

	it("uses row numbers as row-selection handles", () => {
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableRowSelection
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const rowNumberCell = screen.getByText("1").closest("td");
		fireEvent.mouseDown(rowNumberCell!);

		const firstRowCheckbox = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
		expect(firstRowCheckbox.checked).toBe(true);
	});

	it("keeps existing rows selected when another row is selected", () => {
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableRowSelection
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Select row 2" }));

		expect(screen.getByRole("checkbox", { name: "Deselect row 1" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Deselect row 2" })).toBeChecked();
		expect(screen.getByText(/2 selected/)).toBeInTheDocument();
	});

	it("forwards header sort clicks to onSortChange so consumers can mirror to the server", () => {
		const onSortChange = vi.fn();
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableSorting
				onSortChange={onSortChange}
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		// Header click toggles ascending the first time. Without this hook
		// (the previous behaviour), TanStack updated only its internal
		// sorting state and the server was never told — pagination then
		// returned unsorted rows on every page change.
		fireEvent.click(screen.getByText("Name"));
		expect(onSortChange).toHaveBeenLastCalledWith([{ id: "name", desc: false }]);

		fireEvent.click(screen.getByText("Name"));
		expect(onSortChange).toHaveBeenLastCalledWith([{ id: "name", desc: true }]);
	});

	it("opens rows from data cells without treating embedded controls as row clicks", () => {
		const onRowClick = vi.fn();
		const onAction = vi.fn();
		const columnsWithAction: ColumnDef<Row>[] = [
			...columns,
			{
				id: "action",
				header: "",
				cell: () => <button type="button" onClick={onAction}>Act</button>,
			},
		];

		render(
			<DataTable
				columns={columnsWithAction}
				data={rows}
				onRowClick={onRowClick}
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		fireEvent.click(screen.getByText("Ada"));
		expect(onRowClick).toHaveBeenCalledWith(rows[0], 0);

		fireEvent.click(screen.getAllByRole("button", { name: "Act" })[0]);
		expect(onAction).toHaveBeenCalledOnce();
		expect(onRowClick).toHaveBeenCalledOnce();

		const firstRow = screen.getByText("Ada").closest("tr");
		expect(firstRow).toHaveAttribute("tabindex", "0");
		fireEvent.keyDown(firstRow!, { key: "Enter" });
		expect(onRowClick).toHaveBeenCalledTimes(2);
	});
});

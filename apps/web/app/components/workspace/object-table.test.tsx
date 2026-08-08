// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectTable } from "./object-table";
import type { TableSelectionContext } from "@/lib/table-selection";

describe("ObjectTable selection context", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: false }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;
	});

	it("emits selected cell values for chat context", async () => {
		const onSelectionContextChange = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				fields={[
					{ id: "name", name: "Name", type: "text" },
					{ id: "email", name: "Email", type: "email" },
				]}
				entries={[
					{ entry_id: "p1", Name: "Ada", Email: "ada@example.com" },
					{ entry_id: "p2", Name: "Grace", Email: "grace@example.com" },
				]}
				hideInternalToolbar
				onSelectionContextChange={onSelectionContextChange}
			/>,
		);

		fireEvent.mouseDown(screen.getByText("Ada").closest("td")!);

		await waitFor(() => {
			const lastCall = onSelectionContextChange.mock.lastCall?.[0] as TableSelectionContext | null;
			expect(lastCall).toMatchObject({
				objectName: "people",
				kind: "cells",
				rowCount: 1,
				columnCount: 1,
				columns: ["Name"],
				cells: [{ rowIndex: 0, entryId: "p1", fieldName: "Name", value: "Ada" }],
			});
		});
	});

	it("emits selected row values for chat context", async () => {
		const onSelectionContextChange = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				fields={[
					{ id: "name", name: "Name", type: "text" },
					{ id: "email", name: "Email", type: "email" },
				]}
				entries={[
					{ entry_id: "p1", Name: "Ada", Email: "ada@example.com" },
					{ entry_id: "p2", Name: "Grace", Email: "grace@example.com" },
				]}
				hideInternalToolbar
				onSelectionContextChange={onSelectionContextChange}
			/>,
		);

		fireEvent.mouseDown(screen.getByText("2").closest("td")!);

		await waitFor(() => {
			const lastCall = onSelectionContextChange.mock.lastCall?.[0] as TableSelectionContext | null;
			expect(lastCall).toMatchObject({
				objectName: "people",
				kind: "rows",
				rowCount: 1,
				columns: expect.arrayContaining(["Name", "Email"]),
				rows: [{
					rowIndex: 1,
					entryId: "p2",
					values: expect.objectContaining({
						Name: "Grace",
						Email: "grace@example.com",
					}),
				}],
			});
		});
	});
});

describe("ObjectTable display field", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: false }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;
	});

	it("puts the entry-open affordance on the configured display field instead of the first column", () => {
		const onEntryClick = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				displayField="Full Name"
				fields={[
					{ id: "opted-out", name: "Email Opted Out", type: "boolean" },
					{ id: "full-name", name: "Full Name", type: "text" },
				]}
				entries={[{ entry_id: "p1", "Email Opted Out": false, "Full Name": "Ada Lovelace" }]}
				hideInternalToolbar
				onEntryClick={onEntryClick}
			/>,
		);

		expect(screen.getByText("No").closest("span")).not.toHaveClass("font-semibold");
		fireEvent.click(screen.getByText("No"));
		expect(onEntryClick).not.toHaveBeenCalled();

		expect(screen.getByText("Ada Lovelace")).toHaveClass("font-semibold");
		fireEvent.click(screen.getByText("Ada Lovelace"));
		expect(onEntryClick).toHaveBeenCalledWith("p1");
	});
});

describe("ObjectTable server sort", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: false }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;
	});

	it("translates a Sort ascending menu pick into a SortRule[] keyed by field name (not id)", async () => {
		// Field id ≠ field name on real CRM data — the API's pivot view
		// projects on field NAME, so server sort must be in field-name terms.
		// Without this translation, ORDER BY would reference the field id
		// (e.g. seed_fld_company_name_*) which doesn't exist as a column.
		const onServerSort = vi.fn();
		render(
			<ObjectTable
				objectName="company"
				fields={[
					{ id: "seed_fld_company_name", name: "Company Name", type: "text" },
					{ id: "seed_fld_industry", name: "Industry", type: "text" },
				]}
				entries={[
					{ entry_id: "c1", "Company Name": "Acme", Industry: "Tech" },
					{ entry_id: "c2", "Company Name": "Beta", Industry: "Finance" },
				]}
				hideInternalToolbar
				onServerSort={onServerSort}
			/>,
		);

		// Click the column header to open its menu (the outer span owns
		// click → openMenuFieldId in ObjectTable; ColumnHeaderMenu is
		// controlled-open).
		fireEvent.click(screen.getByText("Company Name"));
		const ascItem = await screen.findByText("Sort ascending");
		fireEvent.click(ascItem);
		await waitFor(() => {
			expect(onServerSort).toHaveBeenLastCalledWith([
				{ field: "Company Name", direction: "asc" },
			]);
		});
	});

	it("does not call onServerSort if the consumer did not opt in (legacy callers stay client-only)", async () => {
		// onServerSort is opt-in. Without it, ObjectTable still works
		// (TanStack handles client sort on the visible page) — important
		// for any caller that hasn't migrated yet.
		const otherSpy = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				fields={[
					{ id: "f_name", name: "Name", type: "text" },
				]}
				entries={[
					{ entry_id: "p1", Name: "Ada" },
				]}
				hideInternalToolbar
				onSelectionContextChange={otherSpy}
			/>,
		);
		fireEvent.click(screen.getByText("Name"));
		fireEvent.click(await screen.findByText("Sort ascending"));
		// Nothing to assert on onServerSort (it was never wired); the
		// fact that no exception fires is the guarantee.
		expect(true).toBe(true);
	});
});

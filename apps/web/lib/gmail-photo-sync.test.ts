import { beforeEach, describe, expect, it, vi } from "vitest";

const executeComposioTool = vi.hoisted(() => vi.fn());
const resolveToolSlug = vi.hoisted(() => vi.fn());
const createConcurrencyLimiter = vi.hoisted(() => vi.fn());

const duckdbExecAsync = vi.hoisted(() => vi.fn());
const duckdbQueryAllAsync = vi.hoisted(() => vi.fn());

const getPostgresPhotoSyncPeople = vi.hoisted(() => vi.fn());
const updatePostgresAvatarUrls = vi.hoisted(() => vi.fn());

vi.mock("./composio-execute", () => ({
	executeComposioTool,
	resolveToolSlug,
	createConcurrencyLimiter,
	ComposioToolNoConnectionError: class ComposioToolNoConnectionError extends Error {},
}));

vi.mock("./workspace", () => ({
	duckdbExecAsync,
	duckdbQueryAllAsync,
}));

vi.mock("./crm-postgres/photos", () => ({
	getPostgresPhotoSyncPeople,
	updatePostgresAvatarUrls,
}));

describe("syncGooglePhotos postgres backend", () => {
	beforeEach(() => {
		vi.resetModules();
		executeComposioTool.mockReset();
		resolveToolSlug.mockReset();
		createConcurrencyLimiter.mockReset();
		duckdbExecAsync.mockReset();
		duckdbQueryAllAsync.mockReset();
		getPostgresPhotoSyncPeople.mockReset();
		updatePostgresAvatarUrls.mockReset();

		process.env.CRM_DB_BACKEND = "postgres";
		resolveToolSlug.mockResolvedValue("GMAIL_GET_PEOPLE");
		createConcurrencyLimiter.mockReturnValue((fn: unknown) => fn);
	});

	it("reads postgres people and writes avatar updates without duckdb helpers", async () => {
		getPostgresPhotoSyncPeople.mockResolvedValue([
			{ id: "p1", email: "ada@example.com", avatar_url: null },
		]);
		executeComposioTool.mockResolvedValue({
			data: {
				other_contacts: {
					otherContacts: [
						{
							emailAddresses: [{ value: "ada@example.com" }],
							photos: [{ url: "https://img.test/ada.jpg", default: false, metadata: { source: { type: "PROFILE" } } }],
						},
					],
				},
			},
		});
		updatePostgresAvatarUrls.mockResolvedValue(1);

		const { syncGooglePhotos } = await import("./gmail-photo-sync");
		const summary = await syncGooglePhotos({ connectionId: "conn_1" });

		expect(getPostgresPhotoSyncPeople).toHaveBeenCalledTimes(1);
		expect(updatePostgresAvatarUrls).toHaveBeenCalledWith([
			{ id: "p1", avatarUrl: "https://img.test/ada.jpg" },
		]);
		expect(summary).toEqual({ photosWritten: 1, contactsSeen: 1, reachedEnd: true });
		expect(duckdbQueryAllAsync).not.toHaveBeenCalled();
		expect(duckdbExecAsync).not.toHaveBeenCalled();
	});

	it("no-ops when no postgres person matches fetched contacts", async () => {
		getPostgresPhotoSyncPeople.mockResolvedValue([]);
		executeComposioTool.mockResolvedValue({
			data: {
				other_contacts: {
					otherContacts: [
						{
							emailAddresses: [{ value: "nobody@example.com" }],
							photos: [{ url: "https://img.test/nobody.jpg", default: false, metadata: { source: { type: "PROFILE" } } }],
						},
					],
				},
			},
		});
		updatePostgresAvatarUrls.mockResolvedValue(0);

		const { syncGooglePhotos } = await import("./gmail-photo-sync");
		const summary = await syncGooglePhotos({ connectionId: "conn_1" });

		expect(updatePostgresAvatarUrls).not.toHaveBeenCalled();
		expect(summary).toEqual({ photosWritten: 0, contactsSeen: 1, reachedEnd: true });
		expect(duckdbQueryAllAsync).not.toHaveBeenCalled();
		expect(duckdbExecAsync).not.toHaveBeenCalled();
	});
});

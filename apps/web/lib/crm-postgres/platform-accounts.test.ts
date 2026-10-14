import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPlatformAccount, linkPlatformAccount, listPlatformAccounts,
  unlinkPlatformAccount, updatePlatformAccountReviewStatus,
} from "./platform-accounts";

const { queryPgMock } = vi.hoisted(() => ({ queryPgMock: vi.fn() }));
vi.mock("../postgres", () => ({ queryPg: queryPgMock }));

beforeEach(() => queryPgMock.mockReset());

describe("platform account review", () => {
  it("lists filtered accounts with escaped, parameterized literal search and independent total", async () => {
    queryPgMock.mockResolvedValueOnce([{ total: "84" }]).mockResolvedValueOnce([]);
    const result = await listPlatformAccounts({ reviewStatus: "needs_review", role: "buyer", q: "a_%'", limit: 10, offset: 100 });
    expect(result).toEqual({ rows: [], total: 84 });
    const [sql, args] = queryPgMock.mock.calls[1];
    expect(sql).toContain("review_status = $1 and account_role = $2 and email ilike $3");
    expect(sql).not.toContain("a_%'");
    expect(args).toEqual(["needs_review", "buyer", "%a\\_\\%'%", 10, 100]);
  });

  it.each([{ limit: 0 }, { limit: 1001 }, { offset: -1 }, { offset: 0.5 }])("rejects invalid pagination %j", async (params) => {
    await expect(listPlatformAccounts(params)).rejects.toThrow("pagination");
    expect(queryPgMock).not.toHaveBeenCalled();
  });

  it("reads missing accounts as null", async () => {
    queryPgMock.mockResolvedValue([]);
    expect(await getPlatformAccount("auth-id")).toBeNull();
    expect(queryPgMock.mock.calls[0][1]).toEqual(["auth-id"]);
  });

  it("sets manual links and confirms the decision without modifying people", async () => {
    const row = { auth_user_id: "auth-id", person_id: "person-id", match_method: "manual", review_status: "confirmed" };
    queryPgMock.mockResolvedValue([row]);
    expect(await linkPlatformAccount("auth-id", "person-id")).toEqual(row);
    const [sql, args] = queryPgMock.mock.calls[0];
    expect(sql).toContain("match_method = 'manual'");
    expect(sql).toContain("review_status = 'confirmed'");
    expect(sql).not.toContain("update crm_people");
    expect(args).toEqual(["auth-id", "person-id"]);
  });

  it("rejects empty manual links", async () => {
    await expect(linkPlatformAccount("auth-id", " ")).rejects.toThrow("person");
    expect(queryPgMock).not.toHaveBeenCalled();
  });

  it("unlinks as a protected rejection rather than allowing automatic relinking", async () => {
    queryPgMock.mockResolvedValue([]);
    expect(await unlinkPlatformAccount("auth-id")).toBeNull();
    const [sql, args] = queryPgMock.mock.calls[0];
    expect(sql).toContain("person_id = null");
    expect(sql).toContain("match_method = 'manual'");
    expect(sql).toContain("review_status = 'rejected'");
    expect(args).toEqual(["auth-id"]);
  });

  it("updates reviews and refuses to confirm an unlinked identity", async () => {
    queryPgMock.mockResolvedValue([]);
    expect(await updatePlatformAccountReviewStatus("auth-id", "confirmed")).toBeNull();
    expect(queryPgMock.mock.calls[0][0]).toContain("$2 <> 'confirmed' or person_id is not null");
    expect(queryPgMock.mock.calls[0][1]).toEqual(["auth-id", "confirmed"]);
  });

  it("validates review status at runtime, including inherited object keys", async () => {
    await expect(updatePlatformAccountReviewStatus("auth-id", "toString" as never)).rejects.toThrow("review status");
    expect(queryPgMock).not.toHaveBeenCalled();
  });
});

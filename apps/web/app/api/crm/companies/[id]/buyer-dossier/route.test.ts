import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./route";

const { currentUserMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));
vi.mock("@/lib/auth", () => ({ currentUser: currentUserMock }));

const { getDossierMock, saveDossierMock, markReviewedMock } = vi.hoisted(() => ({
  getDossierMock: vi.fn(),
  saveDossierMock: vi.fn(),
  markReviewedMock: vi.fn(),
}));
vi.mock("@/lib/crm-postgres/buyer-dossier", () => ({
  getCompanyDossier: getDossierMock,
  saveDossier: saveDossierMock,
  markDossierReviewed: markReviewedMock,
}));

const ctx = { params: Promise.resolve({ id: "co_1" }) };

const DOSSIER = {
  company_id: "co_1",
  text: "---\ncompany_id: co_1\n---\nText",
  version: 3,
  updated_at: "2026-11-07 09:00:00+00",
  stale_since: "2026-11-02",
  stale_reasons: [{ date: "2026-11-02", reason: "new saved search", source_id: "saved_search:1" }],
  last_verified: "2026-07-02",
  saved_searches: [],
};

function patch(body: unknown) {
  return new Request("http://localhost/api/crm/companies/co_1/buyer-dossier", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("buyer dossier API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserMock.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "ari@rebattery.io",
      displayName: "Ari",
    });
  });

  it("returns the dossier, its stale reasons and the saved searches", async () => {
    getDossierMock.mockResolvedValue(DOSSIER);
    const res = await GET(new Request("http://localhost/api/crm/companies/co_1/buyer-dossier"), ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      company_id: "co_1",
      version: 3,
      stale_since: "2026-11-02",
      stale_reasons: [{ reason: "new saved search" }],
      last_verified: "2026-07-02",
    });
  });

  it("returns 404 when the company does not exist and 401 without a user", async () => {
    getDossierMock.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/x"), ctx)).status).toBe(404);
    currentUserMock.mockResolvedValueOnce(null as never);
    expect((await GET(new Request("http://localhost/x"), ctx)).status).toBe(401);
  });

  it("saves with the expected version and returns the derived profile", async () => {
    saveDossierMock.mockResolvedValue({
      kind: "saved",
      version: 4,
      updated_at: "2026-11-07 10:00:00+00",
      profile: { chemistries: ["LFP"], passed: 1 },
      derived: ["chemistries"],
      passedThrough: ["evidence_url"],
      profileChanged: true,
    });
    const res = await PATCH(patch({ text: "---\ncompany_id: co_1\n---\n", expected_version: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(saveDossierMock).toHaveBeenCalledWith("co_1", "---\ncompany_id: co_1\n---\n", 3);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      version: 4,
      profile_changed: true,
      passed_through: ["evidence_url"],
    });
  });

  it("answers 409 with the stored text when the editor is stale", async () => {
    saveDossierMock.mockResolvedValue({ kind: "conflict", currentVersion: 5, currentText: "current text" });
    const res = await PATCH(patch({ text: "old draft", expected_version: 3 }), ctx);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ current_version: 5, current_text: "current text" });
  });

  it("answers 400 with the validation errors and writes nothing", async () => {
    saveDossierMock.mockResolvedValue({ kind: "invalid", errors: ["products[0].status: required"] });
    const res = await PATCH(patch({ text: "broken", expected_version: 3 }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ errors: ["products[0].status: required"] });
  });

  it("rejects a body without text or with a version that is not a number", async () => {
    expect((await PATCH(patch({ expected_version: 3 }), ctx)).status).toBe(400);
    expect((await PATCH(patch({ text: "x", expected_version: "three" }), ctx)).status).toBe(400);
    expect(saveDossierMock).not.toHaveBeenCalled();
  });

  it("clears the stale flag on mark reviewed", async () => {
    getDossierMock.mockResolvedValue(DOSSIER);
    markReviewedMock.mockResolvedValue({ ok: true });
    const res = await POST(
      new Request("http://localhost/api/crm/companies/co_1/buyer-dossier", {
        method: "POST",
        body: JSON.stringify({ action: "mark_reviewed" }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(markReviewedMock).toHaveBeenCalledWith("co_1");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

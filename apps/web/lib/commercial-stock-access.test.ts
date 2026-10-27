import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buyRequestAnnouncement, commercialStockAuthorised } from "./commercial-stock-access";

const secret = "x".repeat(40);
const request = (authorization?: string) => new Request("http://crm.test/api/commercial-buyer/stock", { method: "POST", headers: authorization ? { authorization } : {} });

describe("commercialStockAuthorised", () => {
  afterEach(() => { delete process.env.COMMERCIAL_STOCK_SECRET_FILE; });

  it("accepts only the exact bearer secret", () => {
    expect(commercialStockAuthorised(request(`Bearer ${secret}`), secret)).toBe(true);
    expect(commercialStockAuthorised(request(`Bearer ${secret}y`), secret)).toBe(false);
    expect(commercialStockAuthorised(request(secret), secret)).toBe(false);
    expect(commercialStockAuthorised(request(), secret)).toBe(false);
  });

  it("fails closed without a usable secret file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-secret-"));
    process.env.COMMERCIAL_STOCK_SECRET_FILE = join(dir, "missing");
    expect(commercialStockAuthorised(request("Bearer anything"))).toBe(false);
    writeFileSync(join(dir, "short"), "too-short\n");
    process.env.COMMERCIAL_STOCK_SECRET_FILE = join(dir, "short");
    expect(commercialStockAuthorised(request("Bearer too-short"))).toBe(false);
    writeFileSync(join(dir, "ok"), `${secret}\n`);
    process.env.COMMERCIAL_STOCK_SECRET_FILE = join(dir, "ok");
    expect(commercialStockAuthorised(request(`Bearer ${secret}`))).toBe(true);
  });
});

describe("buyRequestAnnouncement", () => {
  it("links the listing, notes shortfalls and cannot ping anyone", () => {
    const text = buyRequestAnnouncement({ listingId: "btd_1", email: "@everyone@example.com", units: 5, suppliers: 2,
      lines: [{ label: "Kia e-Niro", wanted: 5, allocated: 3 }] });
    expect(text).toContain("5x Kia e-Niro (only 3 in stock)");
    expect(text).toContain("listing=btd_1");
    expect(text).not.toContain("@everyone@");
  });
});

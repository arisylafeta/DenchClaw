import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowStockRequest, commercialStockAuthorised, SCOPE_EPOCH_MS, scopeSignature, scopeSignatureValid } from "./commercial-stock-access";

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

describe("scope signatures and the hourly ceiling", () => {
  const key = "k".repeat(40);
  it("accepts a signature for this or the previous 30-day epoch only, and nothing else", () => {
    const now = 100 * SCOPE_EPOCH_MS + 5;
    expect(scopeSignatureValid("wrun_abc12345", scopeSignature("wrun_abc12345", key, 100), key, now)).toBe(true);
    expect(scopeSignatureValid("wrun_abc12345", scopeSignature("wrun_abc12345", key, 99), key, now)).toBe(true);
    expect(scopeSignatureValid("wrun_abc12345", scopeSignature("wrun_abc12345", key, 98), key, now)).toBe(false);
    expect(scopeSignatureValid("wrun_other0000", scopeSignature("wrun_abc12345", key, 100), key, now)).toBe(false);
    expect(scopeSignatureValid("wrun_abc12345", scopeSignature("wrun_abc12345", "x".repeat(40), 100), key, now)).toBe(false);
  });

  it("stops after the hourly limit and resets an hour later", () => {
    const start = 10_000_000_000;
    expect(allowStockRequest(start, 2)).toBe(true);
    expect(allowStockRequest(start + 1, 2)).toBe(true);
    expect(allowStockRequest(start + 2, 2)).toBe(false);
    expect(allowStockRequest(start + 3_600_001, 2)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { hasSameOrigin, requestOrigin } from "./request-origin";

describe("request origin behind a trusted local reverse proxy", () => {
  it("uses validated forwarded host and protocol", () => {
    const req = new Request("http://127.0.0.1:3100/api/auth/login", {
      headers: {
        origin: "https://paper.example.ts.net:8443",
        "x-forwarded-host": "paper.example.ts.net:8443",
        "x-forwarded-proto": "https",
      },
    });
    expect(requestOrigin(req)).toBe("https://paper.example.ts.net:8443");
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("falls back to the request URL for malformed forwarded values", () => {
    const req = new Request("http://localhost:3100/api/auth/login", {
      headers: {
        origin: "http://localhost:3100",
        "x-forwarded-host": "evil.example/path",
        "x-forwarded-proto": "https",
      },
    });
    expect(requestOrigin(req)).toBe("http://localhost:3100");
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("rejects a different browser origin", () => {
    const req = new Request("http://127.0.0.1:3100/api/auth/login", {
      headers: {
        origin: "https://evil.example",
        "x-forwarded-host": "paper.example.ts.net:8443",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasSameOrigin(req)).toBe(false);
  });
});

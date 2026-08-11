import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppPublicOrigin } from "./public-origin";

const ORIGINAL_ENV = process.env.DENCHCLAW_PUBLIC_URL;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.DENCHCLAW_PUBLIC_URL;
  } else {
    process.env.DENCHCLAW_PUBLIC_URL = ORIGINAL_ENV;
  }
});

beforeEach(() => {
  delete process.env.DENCHCLAW_PUBLIC_URL;
});

function makeRequest(opts: {
  url?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  host?: string;
}): Request {
  const headers = new Headers();
  if (opts.forwardedHost) {
    headers.set("x-forwarded-host", opts.forwardedHost);
  }
  if (opts.forwardedProto) {
    headers.set("x-forwarded-proto", opts.forwardedProto);
  }
  if (opts.host) {
    headers.set("host", opts.host);
  }
  return new Request(opts.url ?? "http://localhost:3100/api/settings/mcp/connect/start", {
    method: "POST",
    headers,
  });
}

describe("resolveAppPublicOrigin", () => {
  describe("forwarded headers (cloud / behind reverse proxy)", () => {
    it("uses X-Forwarded-Host + X-Forwarded-Proto when both are present", () => {
      const origin = resolveAppPublicOrigin(
        makeRequest({
          forwardedHost: "dench-com.sandbox.merseoriginals.com",
          forwardedProto: "https",
        }),
      );
      expect(origin).toBe("https://dench-com.sandbox.merseoriginals.com");
    });

    it("defaults to http when X-Forwarded-Proto is missing or unrecognized", () => {
      expect(
        resolveAppPublicOrigin(
          makeRequest({
            forwardedHost: "example.local",
          }),
        ),
      ).toBe("http://example.local");

      expect(
        resolveAppPublicOrigin(
          makeRequest({
            forwardedHost: "example.local",
            forwardedProto: "ws",
          }),
        ),
      ).toBe("http://example.local");
    });

    it("takes the first value from a comma-separated forwarded header chain", () => {
      const origin = resolveAppPublicOrigin(
        makeRequest({
          forwardedHost: "real.example.com, intermediate.example.com",
          forwardedProto: "https",
        }),
      );
      expect(origin).toBe("https://real.example.com");
    });

    it("prefers forwarded headers over DENCHCLAW_PUBLIC_URL — needed for warm-pool slug rebinds where the env var is stale but the Host header is live", () => {
      process.env.DENCHCLAW_PUBLIC_URL =
        "https://stale-warm-pool-slug.sandbox.merseoriginals.com";
      const origin = resolveAppPublicOrigin(
        makeRequest({
          forwardedHost: "real-org-slug.sandbox.merseoriginals.com",
          forwardedProto: "https",
        }),
      );
      expect(origin).toBe("https://real-org-slug.sandbox.merseoriginals.com");
    });
  });

  describe("DENCHCLAW_PUBLIC_URL fallback", () => {
    it("uses the env var when no forwarded headers are present", () => {
      process.env.DENCHCLAW_PUBLIC_URL =
        "https://acme.sandbox.merseoriginals.com";
      const origin = resolveAppPublicOrigin(makeRequest({}));
      expect(origin).toBe("https://acme.sandbox.merseoriginals.com");
    });

    it("normalizes the env var to its origin (drops path/query)", () => {
      process.env.DENCHCLAW_PUBLIC_URL =
        "https://acme.sandbox.merseoriginals.com/some/path?query=1";
      const origin = resolveAppPublicOrigin(makeRequest({}));
      expect(origin).toBe("https://acme.sandbox.merseoriginals.com");
    });

    it("ignores a malformed env var and falls through to request.url", () => {
      process.env.DENCHCLAW_PUBLIC_URL = "this is not a url";
      const origin = resolveAppPublicOrigin(
        makeRequest({
          url: "http://localhost:3100/api/settings/mcp/connect/start",
        }),
      );
      expect(origin).toBe("http://localhost:3100");
    });
  });

  describe("local dev fallback", () => {
    it("returns the request.url origin when neither forwarded headers nor env var are set", () => {
      const origin = resolveAppPublicOrigin(
        makeRequest({
          url: "http://localhost:3100/api/settings/mcp/connect/start",
        }),
      );
      expect(origin).toBe("http://localhost:3100");
    });

    it("falls back to request.url when forwarded host is empty after trimming", () => {
      const origin = resolveAppPublicOrigin(
        makeRequest({
          forwardedHost: "   ",
          forwardedProto: "https",
          url: "http://localhost:3100/api/settings/mcp/connect/start",
        }),
      );
      expect(origin).toBe("http://localhost:3100");
    });
  });
});

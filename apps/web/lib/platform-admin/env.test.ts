import { describe, expect, it } from "vitest";
import {
  getPlatformAdminEnv,
  getPostmarkEnv,
  getSiteEnv,
  getStripeGlobalPayoutsEnv,
} from "./env";

const input = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "supabase-secret",
  POSTMARK_SERVER_TOKEN: "postmark-secret",
  POSTMARK_FROM_EMAIL: "ops@example.com",
  NEXT_PUBLIC_SITE_URL: "https://example.com",
  STRIPE_GLOBAL_PAYOUTS_SECRET_KEY: "stripe-secret",
};

describe("platform admin environment", () => {
  it("exposes only the selected server-side dependencies", () => {
    expect(getPlatformAdminEnv(input)).toEqual({
      supabaseUrl: "https://example.supabase.co",
      supabaseSecretKey: "supabase-secret",
    });
    expect(getPostmarkEnv(input)).toEqual({
      postmarkServerToken: "postmark-secret",
      postmarkFromEmail: "ops@example.com",
    });
    expect(getSiteEnv(input)).toEqual({ siteUrl: "https://example.com" });
    expect(getStripeGlobalPayoutsEnv(input)).toEqual({
      secretKey: "stripe-secret",
    });
  });

  it("fails closed when a required secret is absent", () => {
    expect(() =>
      getPlatformAdminEnv({ ...input, SUPABASE_SECRET_KEY: undefined }),
    ).toThrow("Missing required env var: SUPABASE_SECRET_KEY");
  });
});

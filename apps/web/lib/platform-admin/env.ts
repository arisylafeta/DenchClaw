import "server-only";

export type PlatformAdminEnvInput = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  POSTMARK_SERVER_TOKEN?: string;
  POSTMARK_FROM_EMAIL?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  STRIPE_GLOBAL_PAYOUTS_SECRET_KEY?: string;
};

function readProcessEnv(): PlatformAdminEnvInput {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
    POSTMARK_FROM_EMAIL: process.env.POSTMARK_FROM_EMAIL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    STRIPE_GLOBAL_PAYOUTS_SECRET_KEY:
      process.env.STRIPE_GLOBAL_PAYOUTS_SECRET_KEY,
  };
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getPlatformAdminEnv(
  input: PlatformAdminEnvInput = readProcessEnv(),
) {
  return {
    supabaseUrl: requireNonEmpty(
      input.NEXT_PUBLIC_SUPABASE_URL,
      "NEXT_PUBLIC_SUPABASE_URL",
    ),
    supabaseSecretKey: requireNonEmpty(
      input.SUPABASE_SECRET_KEY,
      "SUPABASE_SECRET_KEY",
    ),
  };
}

export function getPostmarkEnv(input: PlatformAdminEnvInput = readProcessEnv()) {
  return {
    postmarkServerToken: requireNonEmpty(
      input.POSTMARK_SERVER_TOKEN,
      "POSTMARK_SERVER_TOKEN",
    ),
    postmarkFromEmail: requireNonEmpty(
      input.POSTMARK_FROM_EMAIL,
      "POSTMARK_FROM_EMAIL",
    ),
  };
}

export function getSiteEnv(input: PlatformAdminEnvInput = readProcessEnv()) {
  return {
    siteUrl: requireNonEmpty(
      input.NEXT_PUBLIC_SITE_URL,
      "NEXT_PUBLIC_SITE_URL",
    ),
  };
}

export function getStripeGlobalPayoutsEnv(
  input: PlatformAdminEnvInput = readProcessEnv(),
) {
  return {
    secretKey: requireNonEmpty(
      input.STRIPE_GLOBAL_PAYOUTS_SECRET_KEY,
      "STRIPE_GLOBAL_PAYOUTS_SECRET_KEY",
    ),
  };
}

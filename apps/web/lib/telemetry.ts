import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { PostHog } from "posthog-node";
import { resolveOpenClawStateDir } from "./workspace";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";
const DENCHCLAW_VERSION = process.env.NEXT_PUBLIC_DENCHCLAW_VERSION || "";
const OPENCLAW_VERSION = process.env.NEXT_PUBLIC_OPENCLAW_VERSION || "";

let client: PostHog | null = null;

function ensureClient(): PostHog | null {
  if (!POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 10,
      flushInterval: 30_000,
    });
  }
  return client;
}

export type PersonInfo = {
  name?: string;
  email?: string;
  avatar?: string;
  denchOrgId?: string;
};

let _cachedAnonymousId: string | null = null;
let _cachedPersonInfo: PersonInfo | null | undefined = undefined;
let _cachedPrivacyMode: boolean | undefined = undefined;

/**
 * Read the persisted install-scoped anonymous ID from ~/.openclaw-dench/telemetry.json,
 * generating and writing one if absent.
 */
export function getOrCreateAnonymousId(): string {
  if (_cachedAnonymousId) return _cachedAnonymousId;

  try {
    const stateDir = resolveOpenClawStateDir();
    const configPath = join(stateDir, "telemetry.json");

    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    }
    if (typeof raw.anonymousId === "string" && raw.anonymousId) {
      _cachedAnonymousId = raw.anonymousId;
      return raw.anonymousId;
    }
    const id = randomUUID();
    raw.anonymousId = id;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    _cachedAnonymousId = id;
    return id;
  } catch {
    const id = randomUUID();
    _cachedAnonymousId = id;
    return id;
  }
}

/**
 * Persist a partial PersonInfo into ~/.openclaw-dench/telemetry.json,
 * merging with the existing record. Mirrors `writeTelemetryConfig` in the
 * CLI's `src/telemetry/config.ts` so onboarding-collected name/email shows
 * up in PostHog the same way CLI-collected fields would.
 */
export function writePersonInfo(person: Partial<PersonInfo>): PersonInfo | null {
  try {
    const stateDir = resolveOpenClawStateDir();
    const configPath = join(stateDir, "telemetry.json");

    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        raw = {};
      }
    }

    if (typeof person.name === "string" && person.name.trim()) {
      raw.name = person.name.trim();
    }
    if (typeof person.email === "string" && person.email.trim()) {
      raw.email = person.email.trim();
    }
    if (typeof person.avatar === "string" && person.avatar.trim()) {
      raw.avatar = person.avatar.trim();
    }
    if (typeof person.denchOrgId === "string" && person.denchOrgId.trim()) {
      raw.denchOrgId = person.denchOrgId.trim();
    }

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } catch {
    // Non-fatal: telemetry write failure should not break onboarding.
  }
  // Invalidate the read cache so a follow-up `readPersonInfo()` returns the
  // fresh values (the layout reads it on every request thanks to
  // `dynamic = "force-dynamic"`, but cached server modules can outlive a
  // single request).
  _cachedPersonInfo = undefined;
  return readPersonInfo();
}

/**
 * Read optional person identity fields from telemetry.json.
 * Returns null when no identity fields are set.
 */
export function readPersonInfo(): PersonInfo | null {
  if (_cachedPersonInfo !== undefined) return _cachedPersonInfo;

  try {
    const stateDir = resolveOpenClawStateDir();
    const configPath = join(stateDir, "telemetry.json");

    if (!existsSync(configPath)) {
      _cachedPersonInfo = null;
      return null;
    }
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const info: PersonInfo = {};
    if (typeof raw.name === "string" && raw.name) info.name = raw.name;
    if (typeof raw.email === "string" && raw.email) info.email = raw.email;
    if (typeof raw.avatar === "string" && raw.avatar) info.avatar = raw.avatar;
    if (typeof raw.denchOrgId === "string" && raw.denchOrgId) info.denchOrgId = raw.denchOrgId;

    _cachedPersonInfo = Object.keys(info).length > 0 ? info : null;
    return _cachedPersonInfo;
  } catch {
    _cachedPersonInfo = null;
    return null;
  }
}

/**
 * Read privacy mode from telemetry.json.
 * Default is true (privacy on) when the file is missing or unreadable.
 */
export function readPrivacyMode(): boolean {
  if (_cachedPrivacyMode !== undefined) return _cachedPrivacyMode;

  try {
    const stateDir = resolveOpenClawStateDir();
    const configPath = join(stateDir, "telemetry.json");

    if (!existsSync(configPath)) {
      _cachedPrivacyMode = true;
      return true;
    }
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    _cachedPrivacyMode = raw.privacyMode !== false;
    return _cachedPrivacyMode;
  } catch {
    _cachedPrivacyMode = true;
    return true;
  }
}

function personInfoToPostHogProps(person: PersonInfo): Record<string, string> {
  const props: Record<string, string> = {};
  if (person.name) props.$name = person.name;
  if (person.email) props.$email = person.email;
  if (person.avatar) props.$avatar = person.avatar;
  if (person.denchOrgId) props.dench_org_id = person.denchOrgId;
  return props;
}

let _identified = false;

export function trackServer(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  const ph = ensureClient();
  if (!ph) return;

  const id = distinctId || getOrCreateAnonymousId();

  if (!_identified) {
    _identified = true;
    const person = readPersonInfo();
    if (person) {
      ph.identify({
        distinctId: id,
        properties: personInfoToPostHogProps(person),
      });
    }
  }

  ph.capture({
    distinctId: id,
    event,
    properties: {
      ...properties,
      denchclaw_version: DENCHCLAW_VERSION || undefined,
      openclaw_version: OPENCLAW_VERSION || undefined,
    },
  });
}

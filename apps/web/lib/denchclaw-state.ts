/**
 * Per-workspace `.denchclaw/` persistence for onboarding state and the
 * user-extended personal-email blocklist. The DuckDB workspace remains
 * authoritative for CRM rows; this directory is the source of truth for metadata
 * that needs to survive process restarts and browser refreshes.
 *
 * All writes are atomic (write to temp + rename) so a crash in the middle
 * of saving never leaves us with a half-written JSON file the wizard
 * can't read back.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveDenchClawDir } from "./workspace";
import { SKILL_TEMPLATE_IDS, type SkillTemplateId } from "./skill-templates/types";

function isValidSkillTemplateId(value: unknown): value is SkillTemplateId {
  return (
    typeof value === "string" && (SKILL_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const ONBOARDING_FILENAME = "onboarding.json";
const PERSONAL_DOMAINS_FILENAME = "personal-domains.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "welcome"
  | "identity"
  | "dench-cloud"
  | "skill-template"
  | "complete";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "welcome",
  "identity",
  "dench-cloud",
  "skill-template",
  "complete",
];

export type OnboardingIdentity = {
  name: string;
  email: string;
  capturedAt: string;
};

export type OnboardingDenchCloud = {
  source: "cli" | "web";
  skipped: boolean;
  configuredAt: string;
};

export type OnboardingSkillTemplate = {
  templateId?: SkillTemplateId;
  selectedAt?: string;
  promptConsumedAt?: string;
};

export type OnboardingState = {
  version: 1;
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  identity?: OnboardingIdentity;
  denchCloud?: OnboardingDenchCloud;
  skillTemplate?: OnboardingSkillTemplate;
  startedAt: string;
  updatedAt: string;
};

export type PersonalDomainsFile = {
  version: 1;
  /** User-curated additions on top of the bundled blocklist. */
  add: string[];
  /** User-curated removals — domains the bundled list blocks but the user wants treated as company. */
  remove: string[];
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function defaultOnboardingState(): OnboardingState {
  const now = nowIso();
  return {
    version: 1,
    currentStep: "welcome",
    completedSteps: [],
    startedAt: now,
    updatedAt: now,
  };
}

function defaultPersonalDomains(): PersonalDomainsFile {
  return { version: 1, add: [], remove: [], updatedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function denchClawFilePath(filename: string, workspaceName?: string | null): string {
  return join(resolveDenchClawDir(workspaceName), filename);
}

// ---------------------------------------------------------------------------
// Atomic JSON IO
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(path: string, value: unknown): void {
  ensureDir(join(path, ".."));
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
    renameSync(tempPath, path);
  } catch (err) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

function isValidStep(step: unknown): step is OnboardingStep {
  return typeof step === "string" && (ONBOARDING_STEPS as string[]).includes(step);
}

function sanitizeSkillTemplate(input: unknown): OnboardingSkillTemplate | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const skillTemplate: OnboardingSkillTemplate = {};
  if (isValidSkillTemplateId(raw.templateId)) {
    skillTemplate.templateId = raw.templateId;
  }
  if (typeof raw.selectedAt === "string") {
    skillTemplate.selectedAt = raw.selectedAt;
  }
  if (typeof raw.promptConsumedAt === "string") {
    skillTemplate.promptConsumedAt = raw.promptConsumedAt;
  }
  return Object.keys(skillTemplate).length > 0 ? skillTemplate : undefined;
}

function sanitizeOnboardingState(input: unknown): OnboardingState {
  if (!input || typeof input !== "object") {
    return defaultOnboardingState();
  }
  const raw = input as Record<string, unknown>;
  const fallback = defaultOnboardingState();
  const completed = Array.isArray(raw.completedSteps)
    ? (raw.completedSteps as unknown[]).filter(isValidStep)
    : [];
  const currentStep: OnboardingStep = ["connect-gmail", "connect-calendar", "backfill"].includes(
    typeof raw.currentStep === "string" ? raw.currentStep : "",
  )
    ? "skill-template"
    : isValidStep(raw.currentStep)
      ? raw.currentStep
      : "welcome";
  return {
    version: 1,
    currentStep,
    completedSteps: completed,
    identity:
      raw.identity && typeof raw.identity === "object"
        ? (raw.identity as OnboardingIdentity)
        : undefined,
    denchCloud:
      raw.denchCloud && typeof raw.denchCloud === "object"
        ? (raw.denchCloud as OnboardingDenchCloud)
        : undefined,
    skillTemplate: sanitizeSkillTemplate(raw.skillTemplate),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : fallback.startedAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt,
  };
}

export function readOnboardingState(workspaceName?: string | null): OnboardingState {
  const path = denchClawFilePath(ONBOARDING_FILENAME, workspaceName);
  const raw = readJsonFile<unknown>(path, null);
  if (!raw) {
    return defaultOnboardingState();
  }
  return sanitizeOnboardingState(raw);
}

export function writeOnboardingState(
  state: OnboardingState,
  workspaceName?: string | null,
): OnboardingState {
  const next: OnboardingState = {
    ...state,
    version: 1,
    updatedAt: nowIso(),
  };
  writeJsonFileAtomic(denchClawFilePath(ONBOARDING_FILENAME, workspaceName), next);
  return next;
}

/**
 * Mark a step as completed and advance to the next one in the canonical order.
 * Idempotent: re-completing the same step is a no-op for `completedSteps`.
 */
export function advanceOnboardingStep(
  step: OnboardingStep,
  next: OnboardingStep,
  patch: Partial<OnboardingState> = {},
  workspaceName?: string | null,
): OnboardingState {
  const current = readOnboardingState(workspaceName);
  const completed = new Set(current.completedSteps);
  completed.add(step);
  const merged: OnboardingState = {
    ...current,
    ...patch,
    completedSteps: Array.from(completed),
    currentStep: next,
  };
  return writeOnboardingState(merged, workspaceName);
}

export function isOnboardingComplete(workspaceName?: string | null): boolean {
  return readOnboardingState(workspaceName).currentStep === "complete";
}

// ---------------------------------------------------------------------------
// Personal-email domain overrides
// ---------------------------------------------------------------------------

function uniqueLowercase(values: unknown): string[] {
  if (!Array.isArray(values)) {return [];}
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      out.add(value.trim().toLowerCase());
    }
  }
  return Array.from(out);
}

export function readPersonalDomainsOverrides(
  workspaceName?: string | null,
): PersonalDomainsFile {
  const raw = readJsonFile<unknown>(
    denchClawFilePath(PERSONAL_DOMAINS_FILENAME, workspaceName),
    null,
  );
  if (!raw || typeof raw !== "object") {
    return defaultPersonalDomains();
  }
  const rec = raw as Record<string, unknown>;
  return {
    version: 1,
    add: uniqueLowercase(rec.add),
    remove: uniqueLowercase(rec.remove),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}

export function writePersonalDomainsOverrides(
  patch: { add?: string[]; remove?: string[] },
  workspaceName?: string | null,
): PersonalDomainsFile {
  const current = readPersonalDomainsOverrides(workspaceName);
  const next: PersonalDomainsFile = {
    version: 1,
    add: uniqueLowercase(patch.add ?? current.add),
    remove: uniqueLowercase(patch.remove ?? current.remove),
    updatedAt: nowIso(),
  };
  writeJsonFileAtomic(denchClawFilePath(PERSONAL_DOMAINS_FILENAME, workspaceName), next);
  return next;
}

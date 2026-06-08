import {
  ONBOARDING_STEPS,
  advanceOnboardingStep,
  readOnboardingState,
  type OnboardingStep,
  type OnboardingState,
} from "@/lib/denchclaw-state";
import { isSkillTemplateId } from "@/lib/skill-templates";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_STEPS = new Set<OnboardingStep>(ONBOARDING_STEPS);

function isValidStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && VALID_STEPS.has(value as OnboardingStep);
}

export async function GET() {
  return Response.json(readOnboardingState());
}

export async function PUT(req: Request) {
  let body: {
    from?: unknown;
    to?: unknown;
    skipping?: unknown;
    skillTemplate?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const from = body.from;
  const to = body.to;

  if (!isValidStep(from) || !isValidStep(to)) {
    return Response.json(
      { error: "Both `from` and `to` must be valid onboarding steps." },
      { status: 400 },
    );
  }

  const fromIndex = ONBOARDING_STEPS.indexOf(from);
  const toIndex = ONBOARDING_STEPS.indexOf(to);
  if (toIndex < fromIndex && to !== "complete") {
    return Response.json(
      { error: "Cannot move backwards through onboarding." },
      { status: 400 },
    );
  }

  const patch: Partial<OnboardingState> = {};
  if (body.skillTemplate !== undefined) {
    if (from !== "skill-template") {
      return Response.json(
        { error: "Skill template choices can only be saved from the skill-template step." },
        { status: 400 },
      );
    }
    if (!body.skillTemplate || typeof body.skillTemplate !== "object") {
      return Response.json(
        { error: "`skillTemplate` must be an object." },
        { status: 400 },
      );
    }
    const rawSkillTemplate = body.skillTemplate as Record<string, unknown>;
    if (!isSkillTemplateId(rawSkillTemplate.templateId)) {
      return Response.json(
        { error: "Unknown skill template." },
        { status: 400 },
      );
    }
    patch.skillTemplate = {
      templateId: rawSkillTemplate.templateId,
      selectedAt: new Date().toISOString(),
    };
  }

  const next = advanceOnboardingStep(from, to, patch);
  trackServer("onboarding_step_advanced", {
    from,
    to,
    skipping:
      typeof body.skipping === "string" && body.skipping.trim()
        ? body.skipping.trim()
        : undefined,
  });

  return Response.json(next);
}

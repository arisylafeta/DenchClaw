import {
  readOnboardingState,
  writeOnboardingState,
} from "@/lib/denchclaw-state";
import {
  buildSkillTemplatePrompt,
  isSkillTemplateId,
  type SkillTemplateId,
} from "@/lib/skill-templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ConsumeResponse = {
  prompt: string | null;
  templateId?: SkillTemplateId;
};

export async function POST() {
  const state = readOnboardingState();
  const templateId = state.skillTemplate?.templateId;

  if (
    state.currentStep !== "complete" ||
    !isSkillTemplateId(templateId) ||
    state.skillTemplate?.promptConsumedAt
  ) {
    return Response.json({ prompt: null } satisfies ConsumeResponse);
  }

  writeOnboardingState({
    ...state,
    skillTemplate: {
      ...state.skillTemplate,
      promptConsumedAt: new Date().toISOString(),
    },
  });

  return Response.json({
    prompt: buildSkillTemplatePrompt(templateId),
    templateId,
  } satisfies ConsumeResponse);
}

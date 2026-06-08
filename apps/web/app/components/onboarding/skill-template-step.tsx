"use client";

import { useCallback, useState } from "react";
import { SkillTemplateGallery } from "@/app/components/templates/skill-template-gallery";
import type { OnboardingState } from "@/lib/denchclaw-state";
import type { SkillTemplateId } from "@/lib/skill-templates";
import { readOnboardingResponse } from "./response";

export function SkillTemplateStep({
  state,
  onAdvance,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUseTemplate = useCallback(async (templateId: SkillTemplateId) => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "skill-template",
          to: "complete",
          skillTemplate: { templateId },
        }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template choice.");
    } finally {
      setSubmitting(false);
    }
  }, [onAdvance, submitting]);

  return (
    <div className="space-y-7">
      <SkillTemplateGallery
        mode="onboarding"
        selectedTemplateId={state.skillTemplate?.templateId}
        onSelectTemplate={(templateId) => void handleUseTemplate(templateId)}
        actionLabel="Use"
      />

      {error && (
        <p className="text-[12.5px]" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}

      {submitting && (
        <p className="text-right text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
          Saving template…
        </p>
      )}
    </div>
  );
}

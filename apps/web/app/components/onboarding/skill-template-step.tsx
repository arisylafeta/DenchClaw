"use client";

import { useCallback, useState } from "react";
import { SkillTemplateGallery } from "@/app/components/templates/skill-template-gallery";
import type { OnboardingState } from "@/lib/denchclaw-state";
import {
  SKILL_TEMPLATES,
  isSkillTemplateId,
  type SkillTemplateId,
} from "@/lib/skill-templates";
import { readOnboardingResponse } from "./response";

function initialTemplateId(state: OnboardingState): SkillTemplateId {
  const persisted = state.skillTemplate?.templateId;
  return isSkillTemplateId(persisted) ? persisted : SKILL_TEMPLATES[0].id;
}

export function SkillTemplateStep({
  state,
  onAdvance,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
}) {
  const [selectedId, setSelectedId] = useState<SkillTemplateId>(() =>
    initialTemplateId(state),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "skill-template",
          to: "complete",
          skillTemplate: { templateId: selectedId },
        }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template choice.");
    } finally {
      setSubmitting(false);
    }
  }, [onAdvance, selectedId]);

  return (
    <div className="space-y-7">
      <SkillTemplateGallery
        mode="onboarding"
        selectedTemplateId={selectedId}
        onSelectTemplate={setSelectedId}
        actionLabel="Choose"
      />

      {error && (
        <p className="text-[12.5px]" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={submitting}
          className="flex h-10 items-center justify-center rounded-lg px-5 text-[13.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "#fff",
          }}
          onMouseEnter={(e) => {
            if (!submitting) {
              (e.currentTarget as HTMLElement).style.opacity = "0.92";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          {submitting ? "Saving…" : "Start with this"}
        </button>
      </div>
    </div>
  );
}

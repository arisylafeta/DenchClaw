"use client";

import { useMemo, useRef, useState } from "react";
import { FiSearch } from "react-icons/fi";
import {
  SKILL_TEMPLATES,
  SKILL_TEMPLATE_CATEGORIES,
  type SkillTemplate,
  type SkillTemplateCategory,
  type SkillTemplateId,
} from "@/lib/skill-templates";
import { SkillTemplateCard } from "./skill-template-card";

type SkillTemplateGalleryMode = "onboarding" | "dashboard";

type SkillTemplateGalleryProps = {
  selectedTemplateId?: SkillTemplateId;
  onSelectTemplate: (templateId: SkillTemplateId) => void;
  mode?: SkillTemplateGalleryMode;
  className?: string;
  title?: string;
  description?: string;
  actionLabel?: string;
};

function templateMatches(template: SkillTemplate, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    template.title,
    template.summary,
    template.category,
    template.outcome,
    template.autonomy,
    template.userUseCase,
    ...template.personas,
    ...template.triggerModes,
    ...template.suggestedApps.map((app) => app.name),
    ...template.interviewQuestions.map((question) => question.prompt),
    ...template.interviewQuestions.flatMap((question) =>
      question.options?.map((option) => `${option.label} ${option.description ?? ""}`) ?? [],
    ),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function DefaultHeader({ mode }: { mode: SkillTemplateGalleryMode }) {
  const copy =
    mode === "dashboard"
      ? {
          title: "Start from a template.",
          description:
            "Pick a proven workflow and DenchClaw will open a chat to shape it into your own reusable skill.",
        }
      : {
          title: "Choose your first skill.",
          description:
            "Pick one concrete workflow. DenchClaw will interview you, then turn your answers into a reusable skill.",
        };

  return (
    <div>
      <h1
        className="font-instrument text-[34px] leading-[1.1] tracking-tight"
        style={{ color: "var(--color-text)" }}
      >
        {copy.title}
      </h1>
      <p
        className="mt-3 max-w-2xl text-[13.5px] leading-relaxed"
        style={{ color: "var(--color-text-muted)" }}
      >
        {copy.description}
      </p>
    </div>
  );
}

export function SkillTemplateGallery({
  selectedTemplateId,
  onSelectTemplate,
  mode = "dashboard",
  className,
  title,
  description,
  actionLabel = "Use",
}: SkillTemplateGalleryProps) {
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<SkillTemplateCategory | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const filteredTemplates = useMemo(() => {
    return SKILL_TEMPLATES.filter((template) => {
      const matchesCategory = selectedCategory
        ? template.category === selectedCategory
        : true;
      return matchesCategory && templateMatches(template, query);
    });
  }, [query, selectedCategory]);

  const handleInteraction = () => {
    window.setTimeout(() => {
      gridRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 100);
  };

  const handleCategoryClick = (category: SkillTemplateCategory | null) => {
    setSelectedCategory((current) => (current === category ? null : category));
    handleInteraction();
  };

  return (
    <section className={className ? `w-full space-y-6 ${className}` : "w-full space-y-6"}>
      {title || description ? (
        <div>
          {title && (
            <h1
              className="font-instrument text-[34px] leading-[1.1] tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              {title}
            </h1>
          )}
          {description && (
            <p
              className="mt-3 max-w-2xl text-[13.5px] leading-relaxed"
              style={{ color: "var(--color-text-muted)" }}
            >
              {description}
            </p>
          )}
        </div>
      ) : (
        <DefaultHeader mode={mode} />
      )}

      <div className="flex min-h-10 items-center gap-2 overflow-x-auto py-1">
        <div className="group relative shrink-0">
          <FiSearch
            aria-hidden="true"
            className="absolute left-3 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={handleInteraction}
            aria-label="Search templates"
            placeholder="Search templates..."
            className="h-8 w-48 rounded-full border bg-transparent pl-8 pr-3 text-[13px] outline-none transition-[border-color,box-shadow]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
          />
        </div>

        <div
          className="h-4 w-px shrink-0"
          style={{ background: "var(--color-border)" }}
        />

        <button
          type="button"
          onClick={() => handleCategoryClick(null)}
          aria-pressed={selectedCategory === null}
          className="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            borderColor:
              selectedCategory === null ? "var(--color-border)" : "transparent",
            background:
              selectedCategory === null
                ? "var(--color-surface-hover)"
                : "transparent",
            color:
              selectedCategory === null
                ? "var(--color-text)"
                : "var(--color-text-muted)",
          }}
        >
          All
        </button>

        {SKILL_TEMPLATE_CATEGORIES.map((category) => {
          const active = selectedCategory === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => handleCategoryClick(category)}
              aria-pressed={active}
              className="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{
                borderColor: active ? "var(--color-border)" : "transparent",
                background: active ? "var(--color-surface-hover)" : "transparent",
                color: active ? "var(--color-text)" : "var(--color-text-muted)",
              }}
            >
              {category}
            </button>
          );
        })}
      </div>

      <div
        ref={gridRef}
        className="grid scroll-mt-24 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {filteredTemplates.map((template) => (
          <SkillTemplateCard
            key={template.id}
            template={template}
            selected={template.id === selectedTemplateId}
            onUse={() => onSelectTemplate(template.id)}
            actionLabel={actionLabel}
          />
        ))}

        {filteredTemplates.length === 0 && (
          <div
            className="rounded-2xl border px-4 py-10 text-center text-[13px] md:col-span-2 xl:col-span-3"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            No templates found matching your criteria.
          </div>
        )}
      </div>
    </section>
  );
}

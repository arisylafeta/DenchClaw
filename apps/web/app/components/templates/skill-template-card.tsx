"use client";

import { FiArrowUpRight } from "react-icons/fi";
import type { SkillTemplate } from "@/lib/skill-templates";

type SkillTemplateCardProps = {
  template: SkillTemplate;
  selected: boolean;
  onUse: () => void;
  actionLabel?: string;
};

function triggerLabel(mode: SkillTemplate["triggerModes"][number]): string {
  return mode === "scheduled" ? "Cron-ready" : "Manual";
}

function RollingArrow({ size = 14 }: { size?: number }) {
  return (
    <span className="relative overflow-hidden" style={{ height: size, width: size }}>
      <span className="flex flex-col transition-transform duration-300 ease-out group-hover/template-action:-translate-y-1/2">
        <span
          className="flex shrink-0 items-center justify-center"
          style={{ height: size, width: size }}
        >
          <FiArrowUpRight style={{ width: size, height: size }} />
        </span>
        <span
          className="flex shrink-0 items-center justify-center"
          style={{ height: size, width: size }}
        >
          <FiArrowUpRight style={{ width: size, height: size }} />
        </span>
      </span>
    </span>
  );
}

export function SkillTemplateCard({
  template,
  selected,
  onUse,
  actionLabel = "Use",
}: SkillTemplateCardProps) {
  const useLabel = selected ? "Chosen" : actionLabel;

  return (
    <article
      aria-label={template.title}
      data-selected={selected ? "true" : undefined}
      className="group/template-card relative flex h-full min-h-[208px] w-full flex-col rounded-2xl border p-5 text-left transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-sm"
      style={{
        borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
        background: selected
          ? "color-mix(in srgb, var(--color-accent) 9%, var(--color-background))"
          : "var(--color-background)",
        color: "var(--color-text)",
      }}
    >
      <div className="flex-1 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className="text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-muted)" }}
            >
              {template.category}
            </p>
            <h3 className="mt-2 text-[16px] font-medium leading-tight tracking-tight">
              {template.title}
            </h3>
          </div>
          <span
            className="shrink-0 rounded-full px-2 py-1 text-[10.5px] font-semibold"
            style={{
              background: selected
                ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                : "color-mix(in srgb, var(--color-text) 8%, transparent)",
              color: selected ? "var(--color-accent)" : "var(--color-text-muted)",
            }}
          >
            {selected ? "Selected" : template.autonomy}
          </span>
        </div>

        <p
          className="line-clamp-3 text-[13px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          {template.summary}
        </p>
      </div>

      <div className="mt-5 flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {template.triggerModes.map((mode) => (
            <span
              key={mode}
              className="rounded-full px-2 py-1 text-[10.5px] font-medium"
              style={{
                background: "color-mix(in srgb, var(--color-text) 8%, transparent)",
                color: "var(--color-text-muted)",
              }}
            >
              {triggerLabel(mode)}
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={onUse}
          disabled={selected}
          aria-label={`${useLabel} ${template.title}`}
          className={`group/template-action flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold shadow-sm transition-[border-color,color,opacity] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default ${
            selected
              ? "opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover/template-card:opacity-100"
          }`}
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-background)",
            color: selected ? "var(--color-accent)" : "var(--color-text-muted)",
          }}
        >
          {useLabel}
          <RollingArrow />
        </button>
      </div>
    </article>
  );
}

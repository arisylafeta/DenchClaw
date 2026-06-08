"use client";

import { FiArrowUpRight } from "react-icons/fi";
import type { IconType } from "react-icons";
import {
  SiGithub,
  SiGmail,
  SiGooglecalendar,
  SiHubspot,
  SiNotion,
  SiSlack,
} from "react-icons/si";
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

type TemplateApp = SkillTemplate["suggestedApps"][number];

const APP_ICON_META: Record<
  string,
  { icon?: IconType; color: string; label?: string }
> = {
  gmail: { icon: SiGmail, color: "#EA4335" },
  "google-calendar": {
    icon: SiGooglecalendar,
    color: "#4285F4",
    label: "Calendar",
  },
  hubspot: { icon: SiHubspot, color: "#FF7A59" },
  notion: { icon: SiNotion, color: "#111111" },
  slack: { icon: SiSlack, color: "#E01E5A" },
  github: { icon: SiGithub, color: "#181717" },
  linkedin: { color: "#0A66C2", label: "LinkedIn" },
};

function templateApps(template: SkillTemplate): TemplateApp[] {
  const seen = new Set<string>();
  return [...template.requiredApps, ...template.suggestedApps].filter((app) => {
    if (seen.has(app.slug)) {
      return false;
    }
    seen.add(app.slug);
    return true;
  });
}

function AppIconStack({ template }: { template: SkillTemplate }) {
  const requiredSlugs = new Set(template.requiredApps.map((app) => app.slug));
  const apps = templateApps(template);
  const visibleApps = apps.slice(0, 5);
  const overflowCount = Math.max(0, apps.length - visibleApps.length);

  return (
    <div className="flex items-center gap-2" aria-label="Required and suggested apps">
      <div className="flex items-center -space-x-1.5">
        {visibleApps.map((app) => {
          const meta = APP_ICON_META[app.slug];
          const Icon = meta?.icon;
          const isRequired = requiredSlugs.has(app.slug);
          return (
            <span
              key={app.slug}
              className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold"
              title={`${meta?.label ?? app.name}${isRequired ? " (required)" : " (suggested)"}`}
              style={{
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
                color: meta?.color ?? "var(--color-text-secondary)",
              }}
            >
              {Icon ? (
                <Icon aria-hidden="true" size={13} />
              ) : app.slug === "linkedin" ? (
                "in"
              ) : (
                app.name.charAt(0)
              )}
            </span>
          );
        })}
        {overflowCount > 0 && (
          <span
            className="flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[10px] font-semibold"
            style={{
              background: "var(--color-surface)",
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            +{overflowCount}
          </span>
        )}
      </div>
    </div>
  );
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
  return (
    <article
      aria-label={template.title}
      data-selected={selected ? "true" : undefined}
      className="group/template-card relative flex h-full min-h-[208px] w-full flex-col rounded-2xl border p-5 text-left transition-[border-color,box-shadow,background-color] duration-200 ease-out hover:shadow-sm"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
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
        </div>

        <p
          className="line-clamp-3 text-[13px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          {template.summary}
        </p>

        <AppIconStack template={template} />
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
          aria-label={`${actionLabel} ${template.title}`}
          className={`group/template-action flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold shadow-sm transition-[border-color,color,opacity] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
            selected
              ? "opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover/template-card:opacity-100"
          }`}
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-background)",
            color: "var(--color-text-muted)",
          }}
        >
          {actionLabel}
          <RollingArrow />
        </button>
      </div>
    </article>
  );
}

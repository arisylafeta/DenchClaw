/**
 * Inline SVG icon for the right-panel content tab strip. Renders a
 * recognisable glyph for each `ContentTab.kind` so file tabs and CRM/page
 * tabs read distinctly even though they share the same strip.
 *
 * Extracted from the old `TabIcon` in `workspace-content.tsx` and re-keyed on
 * `ContentTabKind` (the new tabs model) instead of the legacy `Tab.type`.
 */

import type { ContentTab } from "@/lib/workspace-tabs";

type IconKind =
  | "people"
  | "company"
  | "inbox"
  | "calendar"
  | "cloud"
  | "skills"
  | "cron"
  | "app"
  | "object"
  | "folder"
  | "file";

function resolveIconKind(tab: ContentTab): IconKind {
  const path = tab.path ?? "";
  // People / Companies render through the standard object pipeline now,
  // so the canonical paths are `people` / `company`. The `~crm/*` checks
  // remain for back-compat with bookmarked legacy URLs.
  if (tab.kind === "object" && (path === "people" || path === "~crm/people")) {return "people";}
  if (
    tab.kind === "object" &&
    (path === "company" || path === "companies" || path === "~crm/companies")
  ) {
    return "company";
  }
  if (tab.kind === "crm-person") {return "people";}
  if (tab.kind === "crm-company") {return "company";}
  if (tab.kind === "crm-inbox") {return "inbox";}
  if (tab.kind === "crm-calendar") {return "calendar";}
  if (tab.kind === "cloud") {return "cloud";}
  if (tab.kind === "skills") {return "skills";}
  if (tab.kind === "cron-dashboard" || tab.kind === "cron-job") {return "cron";}
  if (tab.kind === "app" || path.includes(".dench.app")) {return "app";}
  if (tab.kind === "object") {return "object";}
  if (tab.kind === "directory" || tab.kind === "browse") {return "folder";}
  return "file";
}

export function TabIcon({ tab }: { tab: ContentTab }) {
  const kind = resolveIconKind(tab);
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (kind) {
    case "people":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "company":
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M5 21V7l8-4v18" />
          <path d="M19 21V11l-6-4" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...common}>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M16 2v4" />
          <path d="M8 2v4" />
          <path d="M3 10h18" />
        </svg>
      );
    case "cloud":
      return (
        <svg {...common}>
          <path d="M17.5 19a4.5 4.5 0 1 0-1.97-8.55A6 6 0 1 0 6 18h11.5Z" />
        </svg>
      );
    case "skills":
      return (
        <svg {...common}>
          <path d="m12 3 1.9 5.84H20l-4.95 3.6L16.95 18 12 14.4 7.05 18l1.9-5.56L4 8.84h6.1Z" />
        </svg>
      );
    case "cron":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "app":
      return (
        <svg {...common}>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 9h6v6H9z" />
        </svg>
      );
    case "object":
      return (
        <svg {...common}>
          <path d="M3 3h18v4H3z" />
          <path d="M3 11h18v4H3z" />
          <path d="M3 19h18v2H3z" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case "file":
    default:
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
  }
}

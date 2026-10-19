// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workspace-responsive.module.css"), "utf8");
const rows = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/workspace/hermes-conversations.module.css"), "utf8");
function stylesheet(css: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style.sheet!;
}

describe("pre-hydration responsive CSS contracts (not layout/device QA)", () => {
  it.each([390, 767, 768, 820, 1023, 1024, 1440])("hides desktop-only chrome at the correct initial %spx viewport", width => {
    const hidden = new Set<string>();
    for (const rule of stylesheet(shell).cssRules) {
      if (!(rule instanceof CSSMediaRule)) continue;
      const min = rule.conditionText.match(/min-width:\s*(\d+)px/);
      const max = rule.conditionText.match(/max-width:\s*(\d+)px/);
      if ((min && width < Number(min[1])) || (max && width > Number(max[1]))) continue;
      for (const child of rule.cssRules) {
        if (child instanceof CSSStyleRule && child.style.getPropertyValue("display") === "none") hidden.add(child.selectorText);
      }
    }
    expect(hidden.has(".desktopSidebar")).toBe(width < 768);
    expect(hidden.has('.contentPane[data-open="false"]')).toBe(width < 1024);

  });

  it("never applies row hover/hidden avatar/pin overlays to the default touch input", () => {
    let hoverRules = 0;
    const visit = (rules: CSSRuleList, media?: string) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) visit(rule.cssRules, rule.conditionText);
        if (rule instanceof CSSStyleRule && (rule.selectorText.includes(":hover") || (rule.selectorText === ".rowPin" && rule.style.getPropertyValue("position")))) {
          hoverRules++;
          expect(media).toBe("(hover: hover) and (pointer: fine)");
        }
      }
    };
    visit(stylesheet(rows).cssRules);
    expect(hoverRules).toBeGreaterThan(0);
    expect(rows).not.toContain(":focus-within");
    expect(rows).toContain(':has(:focus-visible)');
    expect(rows).toContain('[data-selected="true"]');
  });
});

import { BASIS_LABEL, type Basis, type DemandKind } from "@/lib/bulk-demand";

const BADGE = {
  request: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" },
  agreed: { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" },
  stated: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" },
  estimated: { background: "transparent", color: "var(--bt-muted)", borderColor: "var(--bt-grey-border)", borderStyle: "dashed" },
} as const;

/** "Request", or the basis of a standing buy-box: "Agreed", "Stated", "Estimated". */
export function DemandBadge({ kind, basis }: { kind: DemandKind; basis: Basis | null }) {
  const key = kind === "request" ? "request" : basis ?? "stated";
  return (
    <span className="rounded-none border px-1.5 py-px text-xs font-medium" style={BADGE[key]}>
      {kind === "request" ? "Request" : BASIS_LABEL[basis ?? "stated"]}
    </span>
  );
}

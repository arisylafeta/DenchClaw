import type { BuyerContext as Context } from "@/lib/buyer-context";
import { safeContextUrl } from "@/lib/buyer-context";
import styles from "./bulk-detail.module.css";

export function BuyerContext({ context }: { context?: Context }) {
  if (!context || !Object.keys(context).length) return null;
  const yesNo = (value: boolean | undefined) =>
    value === undefined ? null : value ? "Required" : "Not required";
  const facts = [
    ["Application", context.application],
    [
      "Minimum usable energy",
      context.min_usable_energy_kwh_per_pack == null
        ? null
        : `${context.min_usable_energy_kwh_per_pack} kWh per pack`,
    ],
    ["Homogeneous within each container", yesNo(context.homogeneous_within_container)],
    ["Repeat supply", yesNo(context.repeat_supply_required)],
    [
      "Container design finalized",
      context.container_design_finalized == null
        ? "Unknown / to confirm"
        : context.container_design_finalized
          ? "Yes"
          : "No (recorded state; reconfirm before sourcing)",
    ],
    ["Latest buyer response", context.latest_buyer_response_on],
    ["Context reviewed", context.reviewed_at],
  ];
  return (
    <section
      aria-label="Buyer context"
      className="space-y-3 border-t pt-4"
      style={{ borderColor: "var(--bt-border)" }}
    >
      <h3 className="text-[14px] font-semibold">Buyer context</h3>
      <dl className={styles.facts}>
        {facts
          .filter(([, value]) => value != null)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {context.pilot_quantity_conflict && (
        <p className="text-[13px]" style={{ color: "var(--bt-amber)" }}>
          Pilot quantity conflict: confirm the required pack count. Observations below do not
          replace the recorded demand quantity.
        </p>
      )}
      {!!context.pilot_quantities_observed?.length && (
        <div className="text-[13px]">
          <h4 className="font-medium">Pilot quantities observed</h4>
          <ul className="mt-1 list-disc pl-5">
            {context.pilot_quantities_observed.map((item, index) => (
              <li key={index}>
                {item.packs} packs · {item.date} · {item.source}
                {item.source_ref && ` (${item.source_ref})`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(
        [
          ["Alternatives to confirm", context.alternatives_to_confirm],
          ["Missing documents", context.missing_documents],
        ] as const
      ).map(
        ([label, items]) =>
          !!items?.length && (
            <div key={label} className="text-[13px]">
              <h4 className="font-medium">{label}</h4>
              <ul className="mt-1 list-disc pl-5">
                {items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          ),
      )}
      {context.next_action && (
        <div className="text-[13px]">
          <h4 className="font-medium">Next action</h4>
          <p>{context.next_action}</p>
        </div>
      )}
      {!!context.sources?.length && (
        <div className="text-[13px]">
          <h4 className="font-medium">Sources</h4>
          <ul className="mt-1 space-y-1">
            {context.sources.map((source, index) => (
              <li key={index}>
                {safeContextUrl(source.url) ? (
                  <a
                    href={safeContextUrl(source.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {source.label}
                  </a>
                ) : (
                  source.label
                )}
                {" · "}
                {source.kind}
                {source.id && ` · ${source.id}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
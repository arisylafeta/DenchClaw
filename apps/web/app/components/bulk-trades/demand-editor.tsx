"use client";

import { useState } from "react";
import styles from "./bulk-detail.module.css";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../platform-admin/ui/select";
import { formatFee, REPUTATION_LABEL } from "@/lib/bulk-demand-score";
import {
  BASES,
  CURRENCIES,
  PRICE_UNITS,
  SPEC_LABELS,
  demandFee,
  SPEC_LISTS,
  SPEC_NUMBERS,
  SPEC_NUMBER_KEYS,
  VOLUME_UNITS,
  type Demand,
  type DemandInput,
  type Spec,
  type SpecListKey,
} from "@/lib/bulk-demand";
import { CrmSearch } from "./buyer-dialogs";
import {
  ErrorText,
  FormField,
  DetailSheet,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  request,
  useForm,
} from "./trade-ui";

const MAIN_LISTS: SpecListKey[] = [
  "chemistries",
  "formats",
  "conditions",
  "origins",
];
const MORE_LISTS: SpecListKey[] = [
  "cell_formats",
  "makes",
  "cell_makers",
  "system_brands",
  "evidence",
  "excludes",
];

/** Toggle chips for one spec list. */
function SpecChips({
  name,
  selected,
  onChange,
}: {
  name: SpecListKey;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div
      role="group"
      aria-label={SPEC_LABELS[name]}
      className="flex flex-col gap-1"
    >
      <span
        className="text-xs font-medium"
        style={{ color: "var(--bt-muted)" }}
      >
        {SPEC_LABELS[name]}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {SPEC_LISTS[name].map((value) => {
          const on = selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on
                    ? selected.filter((item) => item !== value)
                    : [...selected, value],
                )
              }
              className="h-7 rounded-none border px-2 text-xs"
              style={
                on
                  ? {
                      background: "var(--bt-badge)",
                      color: "var(--bt-on-badge)",
                      borderColor: "var(--bt-badge)",
                    }
                  : {
                      background: "var(--bt-surface)",
                      color: "var(--bt-text)",
                      borderColor: "var(--bt-border)",
                    }
              }
            >
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const numberText = (value: number | null | undefined) =>
  value == null ? "" : String(value);
const toNumber = (value: string) =>
  value.trim() === "" ? null : Number(value);

export function DemandDialog({
  demand,
  onClose,
  onSaved,
}: {
  demand: Demand | null;
  onClose: () => void;
  onSaved: (demand: Demand) => void;
}) {
  const [paste, setPaste] = useState("");
  const [showRequired, setShowRequired] = useState(false);
  const [filling, setFilling] = useState(false);
  const [link, setLink] = useState<{
    person_id?: string | null;
    company_id?: string | null;
  }>({});
  const [lists, setLists] = useState<Partial<Record<SpecListKey, string[]>>>(
    () =>
      Object.fromEntries(
        Object.entries(demand?.spec ?? {}).filter(([key]) => key in SPEC_LISTS),
      ),
  );
  const form = useForm(
    {
      kind: demand?.kind ?? "request",
      basis: demand?.basis ?? "stated",
      buyer: demand?.buyer ?? "",
      contact: demand?.contact ?? "",
      email: demand?.email ?? "",
      wants: demand?.wants ?? "",
      quantity: demand?.quantity ?? "",
      location: demand?.location ?? "",
      note: demand?.note ?? "",
      needed_by: demand?.needed_by ?? "",
      volume: numberText(demand?.volume),
      volume_unit: demand?.volume_unit ?? "packs",
      max_price: numberText(demand?.max_price),
      price_currency: demand?.price_currency ?? "EUR",
      price_unit: demand?.price_unit ?? "kWh",
      kwh_min: numberText(demand?.spec.kwh_min),
      kwh_max: numberText(demand?.spec.kwh_max),
      min_soh: numberText(demand?.spec.min_soh),
      mixed_ok:
        demand?.spec.mixed_ok === undefined
          ? ""
          : demand.spec.mixed_ok
            ? "yes"
            : "no",
      product_family: demand?.product_family ?? "",
      fee_eur: numberText(demand?.fee_eur),
      price_basis: demand?.price_basis ?? "estimate",
      reputation: demand?.reputation ?? "anon",
      status: demand?.status ?? "open",
      qualify_question: demand?.qualify_question ?? "",
    },
    async (draft) => {
      const request_ = draft.kind === "request";
      const spec: Spec = { ...lists };
      for (const key of SPEC_NUMBER_KEYS) {
        const value = toNumber(draft[key]);
        if (value !== null) spec[key] = value;
      }
      if (draft.mixed_ok) spec.mixed_ok = draft.mixed_ok === "yes";
      const volume = toNumber(draft.volume);
      const maxPrice = toNumber(draft.max_price);
      const body: Record<string, unknown> = {
        ...link,
        kind: draft.kind,
        ...(request_
          ? { needed_by: draft.needed_by || null }
          : { basis: draft.basis }),
        volume,
        volume_unit: volume === null ? null : draft.volume_unit,
        max_price: maxPrice,
        price_currency: maxPrice === null ? null : draft.price_currency,
        price_unit: maxPrice === null ? null : draft.price_unit,
        spec,
        fee_eur: toNumber(draft.fee_eur),
        price_basis: draft.price_basis,
        reputation: draft.reputation,
        product_family: draft.product_family.trim() || null,
        qualify_question: draft.qualify_question.trim() || null,
        ...(demand?.status === "closed" ? {} : { status: draft.status }),
      };
      for (const key of [
        "buyer",
        "contact",
        "email",
        "wants",
        "quantity",
        "location",
        "note",
      ] as const)
        body[key] = draft[key].trim() || null;
      const { demand: saved } = await request<{ demand: Demand }>(
        demand
          ? `/api/bulk-trades/demand/${encodeURIComponent(demand.id)}`
          : "/api/bulk-trades/demand",
        { method: demand ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      onSaved(saved);
    },
  );

  const fill = () =>
    form.run(async () => {
      setFilling(true);
      try {
        const { fields } = await request<{ fields: DemandInput }>(
          "/api/bulk-trades/demand/fill",
          { method: "POST", body: JSON.stringify({ text: paste }) },
        );
        const { spec, volume, max_price: maxPrice, ...rest } = fields;
        const text = Object.fromEntries(
          Object.entries(rest).filter(
            ([, value]) => typeof value === "string" && value,
          ),
        );
        form.setDraft((current) => ({
          ...current,
          ...text,
          ...(volume != null ? { volume: String(volume) } : {}),
          ...(maxPrice != null ? { max_price: String(maxPrice) } : {}),
          ...Object.fromEntries(
            SPEC_NUMBER_KEYS.filter((key) => spec?.[key] !== undefined).map(
              (key) => [key, String(spec![key])],
            ),
          ),
          ...(spec?.mixed_ok !== undefined
            ? { mixed_ok: spec.mixed_ok ? "yes" : "no" }
            : {}),
        }));
        if (spec)
          setLists((current) => ({
            ...current,
            ...Object.fromEntries(
              Object.entries(spec).filter(([key]) => key in SPEC_LISTS),
            ),
          }));
      } finally {
        setFilling(false);
      }
    });

  const isRequest = form.draft.kind === "request";
  const setList = (key: SpecListKey) => (values: string[]) =>
    setLists((current) => ({ ...current, [key]: values }));
  const select = (
    key: keyof typeof form.draft,
    label: string,
    options: readonly string[],
    labels: Record<string, string> = {},
  ) => (
    <FormField label={label}>
      <Select
        value={form.draft[key] || "__unset"}
        onValueChange={(value) =>
          form.setDraft((current) => ({
            ...current,
            [key]: value === "__unset" ? "" : value,
          }))
        }
      >
        <SelectTrigger
          aria-label={label}
          className="w-full rounded-md border-[var(--bt-border)] bg-[var(--bt-surface)] px-2.5 text-[13px] text-[var(--bt-text)]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          className="bulk-trades z-[10003] rounded-lg border-[var(--bt-border)] bg-[var(--bt-surface)] text-[var(--bt-text)]"
        >
          {options.map((value) => (
            <SelectItem
              key={value}
              value={value || "__unset"}
              className="rounded-md text-[13px] focus:bg-[var(--bt-row-hover)]"
            >
              {labels[value] ?? value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
  const autoFee = demandFee({
    volume: toNumber(form.draft.volume),
    volume_unit: form.draft.volume_unit as Demand["volume_unit"],
    quantity: form.draft.quantity,
    max_price: toNumber(form.draft.max_price),
    price_currency: form.draft.price_currency as Demand["price_currency"],
    price_unit: form.draft.price_unit as Demand["price_unit"],
  });

  return (
    <DetailSheet
      title={demand ? "Edit demand" : "Add demand"}
      onClose={onClose}
      onSubmit={form.submit}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className={`${buttonClass} h-9`}
            style={buttonStyle}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={form.saving}
            className={`${darkButtonClass} h-9`}
            style={darkButtonStyle}
          >
            {demand ? "Save" : "Add demand"}
          </button>
        </>
      }
    >
      <header className="flex items-baseline gap-2 pr-6">
        <h2 className="text-lg font-semibold">
          {demand ? demand.buyer : "Add demand"}
        </h2>
        {demand && (
          <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
            Edit
          </span>
        )}
      </header>
      {!demand && (
        <FormField label="Paste from an email (optional)">
          <textarea
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            rows={3}
            placeholder="We are looking for 100+ NMC packs, 30–70 kWh, for storage builds in India…"
            className="w-full rounded-none border px-2.5 py-2 text-sm"
            style={{
              background: "var(--bt-surface)",
              borderColor: "var(--bt-border)",
              color: "var(--bt-text)",
            }}
          />
          <button
            type="button"
            disabled={filling || paste.trim().length < 10}
            onClick={fill}
            className={`${buttonClass} h-8 self-start`}
            style={buttonStyle}
          >
            {filling ? "Reading…" : "Fill the form"}
          </button>
        </FormField>
      )}
      <section className={styles.formSection} aria-label="Buyer details">
        <h3>Buyer</h3>
        <CrmSearch
          onCompany={(company) => {
            form.setDraft((current) => ({ ...current, buyer: company.name }));
            setLink({ company_id: company.id });
          }}
          onPerson={(person) => {
            form.setDraft((current) => ({
              ...current,
              buyer: person.company ?? person.name,
              contact: person.name,
              email: person.email ?? current.email,
            }));
            setLink({ person_id: person.id });
          }}
        />
        <FormField label="Buyer">
          {form.input("buyer", {
            required: true,
            onInvalid: () => setShowRequired(true),
            "aria-invalid": showRequired && !form.draft.buyer.trim(),
            "aria-describedby":
              showRequired && !form.draft.buyer.trim()
                ? "demand-buyer-error"
                : undefined,
          })}
          {showRequired && !form.draft.buyer.trim() && (
            <span
              id="demand-buyer-error"
              className="text-xs"
              style={{ color: "var(--bt-red)" }}
            >
              Enter a buyer.
            </span>
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Contact">{form.input("contact")}</FormField>
          <FormField label="Email">
            {form.input("email", { type: "email" })}
          </FormField>
        </div>
      </section>
      <section className={styles.formSection} aria-label="Ask details">
        <h3>Ask</h3>
        <FormField label="Ask">
          {form.textarea("wants", {
            required: true,
            rows: 2,
            onInvalid: () => setShowRequired(true),
            "aria-invalid": showRequired && !form.draft.wants.trim(),
            "aria-describedby":
              showRequired && !form.draft.wants.trim()
                ? "demand-ask-error"
                : undefined,
          })}
          {showRequired && !form.draft.wants.trim() && (
            <span
              id="demand-ask-error"
              className="text-xs"
              style={{ color: "var(--bt-red)" }}
            >
              Enter what they want.
            </span>
          )}
        </FormField>
        <FormField label="Product family">
          {form.input("product_family", { placeholder: "e.g. VW MEB" })}
        </FormField>
        <div className="grid grid-cols-2 items-end gap-3">
          <div className={demand?.status === "closed" ? "col-span-2" : ""}>
            <span
              className="mb-1 block text-xs font-medium"
              style={{ color: "var(--bt-muted)" }}
            >
              Kind
            </span>
            <div
              role="group"
              aria-label="Kind"
              className="flex h-9 rounded-md border p-0.5"
              style={{
                borderColor: "var(--bt-border)",
                background: "var(--bt-table-head)",
              }}
            >
              {(["request", "standing"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={form.draft.kind === kind}
                  onClick={() =>
                    form.setDraft((current) => ({ ...current, kind }))
                  }
                  className="flex-1 whitespace-nowrap px-1 text-xs"
                  style={
                    form.draft.kind === kind
                      ? {
                          background: "var(--bt-surface)",
                          color: "var(--bt-text)",
                          boxShadow: "0 1px 3px var(--bt-divider)",
                        }
                      : { color: "var(--bt-muted)" }
                  }
                >
                  {kind === "request" ? "One-off request" : "Standing demand"}
                </button>
              ))}
            </div>
          </div>
          {demand?.status !== "closed" &&
            select("status", "Status", ["open", "qualifying"], {
              open: "Demand",
              qualifying: "Qualifying",
            })}
        </div>
      </section>
      <section className={styles.formSection} aria-label="Quantity and price">
        <h3>Quantity &amp; price</h3>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={isRequest ? "Quantity" : "Quantity / month"}>
            {form.input("volume", { type: "number", min: 0, step: "any" })}
          </FormField>
          {select("volume_unit", "Unit", VOLUME_UNITS)}
        </div>
        <FormField label="Quantity in their words">
          {form.input("quantity", {
            placeholder: "e.g. 100+ packs, 7–8 a month",
          })}
        </FormField>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Max price">
            {form.input("max_price", { type: "number", min: 0, step: "any" })}
          </FormField>
          {select("price_currency", "Currency", CURRENCIES)}
          {select("price_unit", "Per", PRICE_UNITS)}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {isRequest ? (
            <FormField label="Needed by">
              {form.input("needed_by", { type: "date" })}
            </FormField>
          ) : (
            select("basis", "Basis", BASES, {
              estimated: "Estimated",
              stated: "Stated",
              agreed: "Agreed",
            })
          )}
          <FormField label="Location">{form.input("location")}</FormField>
        </div>
      </section>
      <section className={styles.formSection} aria-label="Scoring">
        <h3>Scoring</h3>
        <div className="grid grid-cols-2 gap-3">
          {select("price_basis", "Price basis", ["buyer", "estimate"], {
            buyer: "Buyer budget",
            estimate: "Our estimate",
          })}
          {select(
            "reputation",
            "Reputation",
            ["paid", "active", "email", "inbound", "anon"],
            REPUTATION_LABEL,
          )}
        </div>
        <div>
          <FormField label="Fee override (EUR)">
            {form.input("fee_eur", {
              type: "number",
              min: 0,
              step: "any",
              "aria-describedby": "demand-auto-fee",
            })}
          </FormField>
          <p
            id="demand-auto-fee"
            className="mt-1 text-[11px]"
            style={{ color: "var(--bt-muted)" }}
          >
            auto: {autoFee === null ? "—" : formatFee(autoFee)}
          </p>
        </div>
      </section>
      {form.draft.status === "qualifying" && (
        <section className={styles.formSection} aria-label="Qualification">
          <h3>Qualification</h3>
          <FormField label="Qualification question">
            {form.textarea("qualify_question", { rows: 2 })}
          </FormField>
        </section>
      )}
      <details
        className="border-t pt-4"
        style={{ borderColor: "var(--bt-divider)" }}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Specification
        </summary>
        <fieldset className="mt-3 flex flex-col gap-3">
          <legend className="text-sm font-semibold">Spec</legend>
          {MAIN_LISTS.map((key) => (
            <SpecChips
              key={key}
              name={key}
              selected={lists[key] ?? []}
              onChange={setList(key)}
            />
          ))}
          <div className="grid grid-cols-2 gap-3">
            {SPEC_NUMBER_KEYS.map((key) => (
              <FormField key={key} label={SPEC_NUMBERS[key].label}>
                {form.input(key, {
                  type: "number",
                  min: SPEC_NUMBERS[key].min,
                  max: SPEC_NUMBERS[key].max,
                  step: "any",
                })}
              </FormField>
            ))}
            {select("mixed_ok", "Mixed batches", ["", "yes", "no"], {
              "": "Not known",
              yes: "OK",
              no: "One make and model",
            })}
          </div>
          <details>
            <summary className="cursor-pointer text-[13px] font-medium">
              Makes, cell makers, system brands, evidence, won&apos;t take
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {MORE_LISTS.map((key) => (
                <SpecChips
                  key={key}
                  name={key}
                  selected={lists[key] ?? []}
                  onChange={setList(key)}
                />
              ))}
            </div>
          </details>
        </fieldset>
      </details>
      <FormField label="Note">{form.textarea("note", { rows: 3 })}</FormField>
      <ErrorText error={form.error} />
    </DetailSheet>
  );
}

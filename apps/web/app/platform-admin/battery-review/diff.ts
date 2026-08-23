export type BatteryEvidenceStatus = "pending" | "verified" | "dismissed" | "applied";

export type CanonicalApplicationContext = {
  label: string;
  application: Record<string, unknown> & {
    id: string;
    battery_id: string;
    vehicle_model_id: string;
    updated_at: string;
  };
  battery: Record<string, unknown> & { id: string; updated_at: string };
  vehicle: Record<string, unknown> & { id: string; updated_at: string };
};

export type BatteryEvidenceDifference = {
  field: string;
  label: string;
  owner: "vehicle" | "battery";
  canonical: unknown;
  submitted: unknown;
};

const FIELD_DEFINITIONS = [
  { field: "make", label: "Make", owner: "vehicle", legacy: ["manufacturer"] },
  { field: "model", label: "Model", owner: "vehicle", legacy: [] },
  { field: "vin_patterns", label: "VIN pattern", owner: "vehicle", legacy: ["vinPattern"] },
  { field: "format", label: "Pack level", owner: "battery", legacy: [] },
  { field: "marketed_kwh", label: "Marketed kWh", owner: "battery", legacy: ["kwhPerUnit"] },
  { field: "chemistry_family", label: "Chemistry family", owner: "battery", legacy: ["chemistry"] },
  {
    field: "weight_per_unit_kg",
    label: "Weight per unit (kg)",
    owner: "battery",
    legacy: ["weightPerUnit"],
  },
  { field: "dim_l_mm", label: "Length (mm)", owner: "battery", legacy: ["dimL"] },
  { field: "dim_w_mm", label: "Width (mm)", owner: "battery", legacy: ["dimW"] },
  { field: "dim_h_mm", label: "Height (mm)", owner: "battery", legacy: ["dimH"] },
  { field: "cell_format", label: "Cell format", owner: "battery", legacy: ["cellFormat"] },
  {
    field: "cell_configuration",
    label: "Cell configuration",
    owner: "battery",
    legacy: ["cellConfiguration"],
  },
  {
    field: "battery_platform",
    label: "Battery platform",
    owner: "battery",
    legacy: ["batteryPlatform"],
  },
  { field: "part_numbers", label: "Part number", owner: "battery", legacy: ["partNumber"] },
  { field: "number_of_cells", label: "Number of cells", owner: "battery", legacy: ["numCells"] },
  {
    field: "architecture_voltage",
    label: "Architecture voltage",
    owner: "battery",
    legacy: ["architectureVoltage"],
  },
] as const;

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function submittedValue(
  values: Record<string, unknown>,
  field: string,
  legacy: readonly string[],
): unknown {
  if (Object.prototype.hasOwnProperty.call(values, field)) {
    return values[field];
  }
  for (const legacyField of legacy) {
    if (Object.prototype.hasOwnProperty.call(values, legacyField)) {
      return values[legacyField];
    }
  }
  return null;
}

function isMeaningful(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function normalizedScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedIdentifier(value: unknown): string {
  return normalizedScalar(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function valuesMatch(field: string, canonical: unknown, submitted: unknown): boolean {
  if (field === "part_numbers" || field === "vin_patterns") {
    const canonicalValues = Array.isArray(canonical) ? canonical : [];
    const submittedValues = Array.isArray(submitted) ? submitted : [submitted];
    return submittedValues.every((value) =>
      canonicalValues.some((existing) =>
        field === "part_numbers"
          ? normalizedIdentifier(existing) === normalizedIdentifier(value)
          : normalizedScalar(existing) === normalizedScalar(value),
      ),
    );
  }

  const canonicalNumber = typeof canonical === "number" ? canonical : Number(canonical);
  const submittedNumber = typeof submitted === "number" ? submitted : Number(submitted);
  if (
    canonical !== "" &&
    submitted !== "" &&
    Number.isFinite(canonicalNumber) &&
    Number.isFinite(submittedNumber)
  ) {
    return canonicalNumber === submittedNumber;
  }
  return normalizedScalar(canonical) === normalizedScalar(submitted);
}

export function buildBatteryEvidenceDifferences(
  submittedValues: unknown,
  context: CanonicalApplicationContext | null,
): BatteryEvidenceDifference[] {
  if (!context) {
    return [];
  }
  const values = valueRecord(submittedValues);

  return FIELD_DEFINITIONS.flatMap((definition) => {
    const submitted = submittedValue(values, definition.field, definition.legacy);
    if (!isMeaningful(submitted)) {
      return [];
    }
    const ownerRow = definition.owner === "vehicle" ? context.vehicle : context.battery;
    const canonical = ownerRow[definition.field];
    if (valuesMatch(definition.field, canonical, submitted)) {
      return [];
    }

    return [
      {
        field: definition.field,
        label: definition.label,
        owner: definition.owner,
        canonical,
        submitted: Array.isArray(submitted) ? submitted[0] : submitted,
      } satisfies BatteryEvidenceDifference,
    ];
  });
}

export function buildStoredReviewDifferences(
  canonicalBefore: unknown,
  reviewedValues: unknown,
  approvedFields: unknown,
): BatteryEvidenceDifference[] {
  const before = valueRecord(canonicalBefore);
  const vehicle = valueRecord(before.vehicle);
  const battery = valueRecord(before.battery);
  const reviewed = valueRecord(reviewedValues);
  const approved = new Set(
    Array.isArray(approvedFields)
      ? approvedFields.filter((field): field is string => typeof field === "string")
      : [],
  );

  return FIELD_DEFINITIONS.flatMap((definition) => {
    if (!approved.has(definition.field) || !(definition.field in reviewed)) {
      return [];
    }
    const ownerRow = definition.owner === "vehicle" ? vehicle : battery;
    return [
      {
        field: definition.field,
        label: definition.label,
        owner: definition.owner,
        canonical: ownerRow[definition.field],
        submitted: reviewed[definition.field],
      } satisfies BatteryEvidenceDifference,
    ];
  });
}

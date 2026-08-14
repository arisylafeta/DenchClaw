export type ConfirmationOfPayeeStatus =
  | "uninitiated"
  | "awaiting_acknowledgement"
  | "confirmed";

export type ConfirmationOfPayeeMatchResult =
  | "match"
  | "partial_match"
  | "mismatch"
  | "unavailable";

export type RecipientReadiness = "pending" | "active" | "restricted" | "failed";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function atPath(root: unknown, path: string[]): unknown {
  let value: unknown = root;
  for (const key of path) value = asObject(value)[key];
  return value;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds)
      ? null
      : new Date(milliseconds).toISOString();
  }
  return null;
}

function capabilityStatus(value: unknown): string | null {
  if (typeof value === "string") return value;
  return asString(asObject(value).status);
}

function requirementsDue(requirements: JsonObject): number {
  if (Array.isArray(requirements.currently_due)) {
    return requirements.currently_due.length;
  }
  const entries = requirements.entries;
  return Array.isArray(entries) ? entries.length : 0;
}

function defaultPayoutMethod(account: JsonObject): JsonObject {
  const paths = [
    ["configuration", "recipient", "default_outbound_destination"],
    ["configuration", "recipient", "default_payout_method"],
    ["configuration", "recipient", "default_payout_methods", "local"],
    ["defaults", "payout_method"],
    ["default_payout_method"],
  ];
  for (const path of paths) {
    const candidate = asObject(atPath(account, path));
    if (asString(candidate.id)) return candidate;
  }
  return {};
}

export function normalisePayoutReviewContext(
  accountValue: unknown,
  bankAccountValue: unknown,
) {
  const account = asObject(accountValue);
  const bankAccount = asObject(bankAccountValue);
  const recipient = asObject(atPath(account, ["configuration", "recipient"]));
  const capabilities = asObject(recipient.capabilities);
  const local = capabilityStatus(atPath(capabilities, ["bank_accounts", "local"]));
  const wire = capabilityStatus(atPath(capabilities, ["bank_accounts", "wire"]));
  const statuses = [local, wire].filter(Boolean);
  const due = requirementsDue(asObject(account.requirements));
  const payoutMethod = defaultPayoutMethod(account);
  const confirmationOfPayee = asObject(bankAccount.confirmation_of_payee);
  const result = asObject(confirmationOfPayee.result);
  const rawCopStatus = asString(confirmationOfPayee.status);
  const rawMatchResult = asString(result.match_result);

  let accountReadiness: RecipientReadiness = "pending";
  if (statuses.includes("failed")) accountReadiness = "failed";
  else if (
    statuses.some((status) => status === "restricted" || status === "inactive")
  ) {
    accountReadiness = "restricted";
  } else if (statuses.includes("active") && due === 0) {
    accountReadiness = "active";
  }

  return {
    recipientId: asString(account.id),
    payoutMethodId: asString(payoutMethod.id),
    payoutMethodType: asString(payoutMethod.type),
    accountReadiness,
    requirementsDue: due,
    confirmationOfPayeeStatus: [
      "uninitiated",
      "awaiting_acknowledgement",
      "confirmed",
    ].includes(rawCopStatus ?? "")
      ? (rawCopStatus as ConfirmationOfPayeeStatus)
      : null,
    confirmationOfPayeeMatchResult: [
      "match",
      "partial_match",
      "mismatch",
      "unavailable",
    ].includes(rawMatchResult ?? "")
      ? (rawMatchResult as ConfirmationOfPayeeMatchResult)
      : null,
    confirmationOfPayeeMessage: asString(result.message),
    confirmationOfPayeeCheckedAt: toIsoTimestamp(result.created),
  };
}

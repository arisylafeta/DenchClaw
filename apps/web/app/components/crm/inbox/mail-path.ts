import type { MailFilters } from "@/lib/mail-types";

/** Canonical workspace location shared by the old standalone mail routes. */
export function mailPath(view: MailFilters["view"] = "conversations", campaignId?: string): string {
  const params = new URLSearchParams({ crm: "inbox", view: view ?? "conversations" });
  if (campaignId) {params.set("campaignDetail", campaignId);}
  return `/?${params.toString()}`;
}

export const denchIntegrationsBrand = {
  displayName: "ReBattery Integrations",
  singularDisplayName: "ReBattery Integration",
  searchLabel: "Searching ReBattery Integrations",
  callLabel: "Calling ReBattery Integration",
  genericToolLabel: "Using ReBattery Integrations",
  attentionLabel: "ReBattery Integrations needs attention",
} as const;

export function formatDenchIntegrationsStatusError(
  action: "load" | "update",
  status?: number,
): string {
  const base = `Failed to ${action} ${denchIntegrationsBrand.displayName} status`;
  return typeof status === "number" ? `${base} (${status})` : `${base}.`;
}

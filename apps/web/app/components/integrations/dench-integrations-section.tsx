"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SiElevenlabs } from "react-icons/si";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import type {
  DenchIntegrationId,
  IntegrationRepairEntry,
  DenchIntegrationState,
  IntegrationRuntimeRefresh,
  IntegrationsState,
  ManagedPluginRepairId,
} from "@/lib/integrations";

export type IntegrationActionNotice = {
  tone: "success" | "warning";
  message: string;
};
type IntegrationToggleResponse = IntegrationsState & {
  integration: DenchIntegrationId;
  changed: boolean;
  refresh: IntegrationRuntimeRefresh;
};
type IntegrationRepairResponse = IntegrationsState & {
  changed: boolean;
  repairs: IntegrationRepairEntry[];
  repairedIds: ManagedPluginRepairId[];
  refresh: IntegrationRuntimeRefresh;
};

function RefreshNoticeBanner({ notice }: { notice: IntegrationActionNotice }) {
  const toneClass = notice.tone === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-amber-500/30 bg-amber-500/10 text-amber-100";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      {notice.message}
    </div>
  );
}

function integrationLogo(id: DenchIntegrationId): ReactNode {
  switch (id) {
    case "exa":
      return (
        <img
          src="/integrations/exa-logomark.svg"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 shrink-0 object-contain"
          draggable={false}
        />
      );
    case "apollo":
      return (
        <img
          src="/rebattery-workspace-icon.svg"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 shrink-0 rounded-md object-contain"
          draggable={false}
        />
      );
    case "elevenlabs":
      return <SiElevenlabs className="h-5 w-5 shrink-0" aria-hidden />;
  }
}

function integrationDisplayNameFromId(id: DenchIntegrationId, fallbackLabel?: string): string {
  switch (id) {
    case "apollo":
      return "ReBattery Enrichments";
    case "exa":
      return fallbackLabel ?? "Exa";
    case "elevenlabs":
      return fallbackLabel ?? "ElevenLabs";
  }
}

function repairDisplayNameFromId(id: ManagedPluginRepairId): string {
  switch (id) {
    case "apollo":
      return "ReBattery Enrichments";
    case "exa":
      return "Exa";
    case "dench-ai-gateway":
      return "ReBattery AI Gateway";
    case "dench-identity":
      return "ReBattery Identity";
    case "posthog":
      return "PostHog";
  }
}

function integrationDisplayName(integration: DenchIntegrationState): string {
  return integrationDisplayNameFromId(integration.id, integration.label);
}

const INTEGRATION_DESCRIPTIONS: Record<DenchIntegrationId, string> = {
  exa: "Search the web with Exa",
  apollo: "Enrich people and company data",
  elevenlabs: "Generate speech with ElevenLabs",
};

function IntegrationCard({
  integration,
  isSaving,
  onToggle,
}: {
  integration: DenchIntegrationState;
  isSaving: boolean;
  onToggle: (integration: DenchIntegrationState, enabled: boolean) => void;
}) {
  const displayName = integrationDisplayName(integration);
  const description = INTEGRATION_DESCRIPTIONS[integration.id];
  const statusText = isSaving
    ? "Saving..."
    : integration.locked
      ? "Unavailable until ReBattery Cloud is ready"
      : description;

  return (
    <div
      className="flex items-center justify-between gap-4 rounded-xl px-1 py-2"
      style={{
        background: "transparent",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
        >
          {integrationLogo(integration.id)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {displayName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-muted-foreground">
            <span>{statusText}</span>
            {integration.lockBadge && (
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                }}
              >
                {integration.lockBadge}
              </span>
            )}
          </div>
        </div>
      </div>
      <Switch
        aria-label={`Toggle ${displayName}`}
        checked={integration.enabled}
        disabled={isSaving || integration.locked}
        onCheckedChange={(checked) => onToggle(integration, checked)}
      />
    </div>
  );
}

type DenchIntegrationsSectionProps = {
  data?: IntegrationsState | null;
  loading?: boolean;
  error?: string | null;
  savingId?: DenchIntegrationId | null;
  repairing?: boolean;
  notice?: IntegrationActionNotice | null;
  /** Hide these integrations from this list (e.g. apollo rendered next to waterfall UI elsewhere). */
  excludeIntegrationIds?: readonly DenchIntegrationId[];
  onToggle?: (integration: DenchIntegrationState, enabled: boolean) => void;
  onRetry?: () => void;
  onRepair?: () => void;
};

export function DenchIntegrationsSection(props: DenchIntegrationsSectionProps = {}) {
  const controlled = props.data !== undefined || props.loading !== undefined || props.error !== undefined || props.onToggle !== undefined;
  const [data, setData] = useState<IntegrationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<DenchIntegrationId | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [notice, setNotice] = useState<IntegrationActionNotice | null>(null);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations");
      if (!response.ok) {
        throw new Error(`Failed to load integrations (${response.status})`);
      }
      const payload = (await response.json()) as IntegrationsState;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!controlled) {
      void fetchIntegrations();
    }
  }, [controlled, fetchIntegrations]);

  const resolvedData = controlled ? props.data ?? null : data;
  const resolvedLoading = controlled ? props.loading ?? false : loading;
  const resolvedError = controlled ? props.error ?? null : error;
  const resolvedSavingId = controlled ? props.savingId ?? null : savingId;
  const resolvedRepairing = controlled ? props.repairing ?? false : repairing;
  const resolvedNotice = controlled ? props.notice ?? null : notice;

  const integrations = useMemo(() => resolvedData?.integrations ?? [], [resolvedData]);
  const excludedIds = useMemo(
    () => new Set(props.excludeIntegrationIds ?? []),
    [props.excludeIntegrationIds],
  );
  const visibleIntegrations = useMemo(
    () => integrations.filter((integration) => !excludedIds.has(integration.id)),
    [integrations, excludedIds],
  );
  const needsRepair = useMemo(
    () =>
      integrations.some(
        (integration) =>
          (integration.id === "exa" || integration.id === "apollo") &&
          integration.health.pluginMissing,
      ) ||
      (resolvedData?.managedPlugins ?? []).some((plugin) => plugin.required && plugin.health.pluginMissing),
    [integrations, resolvedData?.managedPlugins],
  );

  const applyState = useCallback((nextState: IntegrationsState) => {
    if (!controlled) {
      setData(nextState);
    }
  }, [controlled]);

  const handleToggle = useCallback(async (integration: DenchIntegrationState, enabled: boolean) => {
    if (props.onToggle) {
      props.onToggle(integration, enabled);
      return;
    }
    const displayName = integrationDisplayName(integration);
    setSavingId(integration.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/integrations/${integration.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = (await response.json()) as IntegrationToggleResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : `Failed to update ${displayName}`);
      }

      const nextState = payload as IntegrationToggleResponse;
      applyState(nextState);
      if (nextState.refresh.restarted) {
        setNotice({
          tone: "success",
          message: `${displayName} updated and the ${nextState.refresh.profile} gateway restarted successfully.`,
        });
      } else if (nextState.changed) {
        setNotice({
          tone: "warning",
          message: `${displayName} updated, but the gateway restart did not complete: ${nextState.refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({
          tone: "success",
          message: `${displayName} was already in the requested state.`,
        });
      }
    } catch (err) {
      setNotice({
        tone: "warning",
        message: err instanceof Error ? err.message : `Failed to update ${displayName}.`,
      });
    } finally {
      setSavingId(null);
    }
  }, [applyState, props]);

  const handleRepair = useCallback(async () => {
    if (props.onRepair) {
      props.onRepair();
      return;
    }
    setRepairing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/integrations/repair", {
        method: "POST",
      });
      const payload = (await response.json()) as IntegrationRepairResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : "Failed to repair integrations.");
      }

      const nextState = payload as IntegrationRepairResponse;
      applyState(nextState);
      if (nextState.changed && nextState.refresh.restarted) {
        const repairedNames = nextState.repairedIds.length > 0
          ? nextState.repairedIds
            .map((id) => repairDisplayNameFromId(id))
            .join(", ")
          : "profiles";
        setNotice({
          tone: "success",
          message: `Repair completed for ${repairedNames} and the ${nextState.refresh.profile} gateway restarted successfully.`,
        });
      } else if (nextState.changed) {
        setNotice({
          tone: "warning",
          message: `Repair updated the profile, but the gateway restart did not complete: ${nextState.refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({
          tone: "success",
          message: "No repair changes were needed for this profile.",
        });
      }
    } catch (err) {
      setNotice({
        tone: "warning",
        message: err instanceof Error ? err.message : "Failed to repair integrations.",
      });
    } finally {
      setRepairing(false);
    }
  }, [applyState, props]);

  if (resolvedLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  if (resolvedError) {
    return (
      <div
        className="rounded-xl border px-4 py-4 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p className="text-sm mb-2" style={{ color: "var(--color-text-muted)" }}>{resolvedError}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (props.onRetry) {
              props.onRetry();
              return;
            }
            void fetchIntegrations();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!resolvedData) return null;

  return (
    <div className="space-y-4">
      {resolvedNotice && <RefreshNoticeBanner notice={resolvedNotice} />}

      {needsRepair && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleRepair()}
          disabled={resolvedRepairing}
        >
          {resolvedRepairing ? "Repairing..." : "Repair older profiles"}
        </Button>
      )}

      <div className="space-y-1">
        {visibleIntegrations.map((integration) => (
          <IntegrationCard
            key={integration.id}
            integration={integration}
            isSaving={resolvedSavingId === integration.id}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </div>
  );
}

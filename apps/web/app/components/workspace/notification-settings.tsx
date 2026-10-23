"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Switch } from "@/app/components/ui/switch";
import {
  isIos,
  isStandalone,
  notificationsSupported,
  readNotificationPrefs,
  registerServiceWorker,
  showAgentNotification,
  writeNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/agent-notify";

type Permission = NotificationPermission | "unsupported";

const muted = { color: "var(--color-text-muted)" } as const;

function Row({ label, hint, checked, onChange, disabled }: {
  label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{label}</div>
        <div className="text-xs" style={muted}>{hint}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export function NotificationSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [permission, setPermission] = useState<Permission>("default");
  const [prefs, setPrefs] = useState<NotificationPrefs>({ start: true, done: true });
  const [needsInstall, setNeedsInstall] = useState(false);

  const refresh = useCallback(() => {
    setPermission(notificationsSupported() ? Notification.permission : "unsupported");
    setPrefs(readNotificationPrefs());
    // iOS only exposes notifications to a site added to the Home Screen.
    setNeedsInstall(isIos() && !isStandalone());
  }, []);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const enable = async () => {
    await registerServiceWorker();
    setPermission(await Notification.requestPermission());
  };
  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeNotificationPrefs(next);
  };
  const enabled = permission === "granted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>Get alerted when an agent starts replying or finishes, while the app is in the background.</DialogDescription>
        </DialogHeader>

        {permission === "unsupported" || needsInstall ? (
          <p className="rounded-lg border p-3 text-xs" style={muted}>
            {needsInstall
              ? "On iPhone, open ReBattery CRM from the Home Screen icon (Share, then Add to Home Screen) and return here. Requires iOS 16.4 or later."
              : "This browser does not support notifications."}
          </p>
        ) : permission === "denied" ? (
          <p className="rounded-lg border p-3 text-xs" style={muted}>
            Notifications are blocked. Re-enable them in your device or browser settings for this site (on iPhone: Settings, Notifications, ReBattery CRM), then reopen this page.
          </p>
        ) : !enabled ? (
          <button
            type="button"
            onClick={() => void enable()}
            className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900"
          >
            <BellIcon className="size-4" aria-hidden />
            Enable notifications
          </button>
        ) : null}

        <div className="divide-y">
          <Row label="Response started" hint="When an agent begins replying" checked={prefs.start} disabled={!enabled} onChange={(start) => update({ start })} />
          <Row label="Agent finished" hint="When a reply is complete" checked={prefs.done} disabled={!enabled} onChange={(done) => update({ done })} />
        </div>

        {enabled && (
          <button
            type="button"
            onClick={() => void showAgentNotification({ title: "ReBattery CRM", body: "Notifications are working.", tag: "test" })}
            className="self-start text-xs underline"
            style={muted}
          >
            Send a test notification
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

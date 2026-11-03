"use client";

import { useEffect } from "react";
import { registerServiceWorker, syncPushPrefs } from "@/lib/agent-notify";

export function PwaRegister() {
  useEffect(() => { void registerServiceWorker().then(() => syncPushPrefs()); }, []);
  return null;
}

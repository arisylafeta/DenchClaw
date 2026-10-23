"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/agent-notify";

export function PwaRegister() {
  useEffect(() => { void registerServiceWorker(); }, []);
  return null;
}

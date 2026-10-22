"use client";

import { useEffect } from "react";
import { registerServiceWorker, requestPermissionOnFirstGesture } from "@/lib/agent-notify";

export function PwaRegister() {
  useEffect(() => {
    void registerServiceWorker();
    return requestPermissionOnFirstGesture();
  }, []);
  return null;
}

"use client";

import { useEffect, useState } from "react";
import type { Registry } from "@/lib/bulk-registry";
import { peekShared, sharedGet } from "./trade-ui";

const REGISTRY_URL = "/api/bulk-trades/registry";

/**
 * The attribute registry (trade fields, buyer-ask lists, units, required files) from the database.
 * Null until the first load; later mounts reuse the cached copy.
 */
export function useRegistry(): Registry | null {
  const [registry, setRegistry] = useState<Registry | null>(() => peekShared<{ registry: Registry }>(REGISTRY_URL)?.registry ?? null);
  useEffect(() => {
    if (registry) return;
    let live = true;
    sharedGet<{ registry: Registry }>(REGISTRY_URL).then((data) => { if (live) setRegistry(data.registry); }).catch(() => {});
    return () => { live = false; };
  }, [registry]);
  return registry;
}

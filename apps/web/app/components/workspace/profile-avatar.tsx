"use client";

import { useState } from "react";
import { initialsFromName } from "@/lib/avatar-initials";

export function ProfileAvatar({ name, className = "h-8 w-8" }: { name: string; className?: string }) {
  const [failedName, setFailedName] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-400/15 text-xs font-semibold ${className}`}
    >
      {initialsFromName(name.replace(/[-_]/g, " "))}
      {failedName !== name && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={name}
          src={`/api/workspace/avatar?name=${encodeURIComponent(name)}`}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailedName(name)}
        />
      )}
    </span>
  );
}

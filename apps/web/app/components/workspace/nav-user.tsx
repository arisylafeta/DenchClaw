"use client";

import { useEffect, useState } from "react";
import { EllipsisIcon, LogOutIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { PersonAvatar } from "@/app/components/crm/person-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";

export type NavUserData = {
  displayName: string;
  email: string;
};

export function NavUser({
  user,
  onSignOut,
  compact = false,
}: {
  user: NavUserData;
  onSignOut: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";
  const switchTheme = () => setTheme(isDark ? "light" : "dark");

  return (
    <div className={compact ? "flex justify-center px-2 py-1.5" : "mx-2 mb-2 flex min-w-0 items-center gap-2 rounded-xl px-2 py-2"}>
      {!compact && (
        <>
          <PersonAvatar name={user.displayName} seed={user.email} size="sm" />
          <div className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
              {user.displayName}
            </span>
            <span className="truncate text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {user.email}
            </span>
          </div>
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-neutral-400/15"
          style={{ color: "var(--color-text-muted)" }}
          aria-label="Open user menu"
          title="User menu"
        >
          <EllipsisIcon className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side={compact ? "right" : "top"} sideOffset={8} className="min-w-[190px]">
          <div className="min-w-0 px-2 py-1.5">
            <div className="truncate text-xs font-medium" style={{ color: "var(--color-text)" }}>
              {user.displayName}
            </div>
            <div className="truncate text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {user.email}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={switchTheme}>
            {isDark ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
            {isDark ? "Light mode" : "Dark mode"}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void onSignOut()}>
            <LogOutIcon aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

/** Shimmering placeholder block. Size and shape come from `className`. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("dench-skeleton rounded-md", className)} {...props} />;
}

export { Skeleton };

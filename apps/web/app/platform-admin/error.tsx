"use client";

import { AlertTriangleIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/app/components/platform-admin/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/platform-admin/ui/card";

export default function PlatformAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6 lg:p-8">
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-amber-50 text-amber-700">
              <AlertTriangleIcon className="size-5" />
            </span>
            <CardTitle>Live platform data could not be loaded</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Dench retried the read, but the platform did not return a usable response. Your data was not changed.
          </p>
          {error.digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
          <Button type="button" onClick={reset}>
            <RotateCwIcon /> Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

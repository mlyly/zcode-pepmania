import type {ReactNode} from "react";
import {AlertTriangle, RotateCcw} from "lucide-react";

import {describeStorageError} from "@/lib/db/quota";

/**
 * Compact recovery UI shared by the route-level error boundaries
 * (`app/error.tsx`, `app/global-error.tsx`). Storage failures get a
 * concrete hint instead of a raw DOMException name.
 */
export function RouteErrorFallback({
                                       error,
                                       retry,
                                       children,
                                   }: {
    error: unknown;
    retry: () => void;
    /** Optional extra actions (e.g. a home link). */
    children?: ReactNode;
}) {
    return (
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
            <div className="bg-muted rounded-full border p-3">
                <AlertTriangle className="text-destructive size-6" aria-hidden/>
            </div>
            <h2 className="text-base font-semibold">Something went wrong</h2>
            <p className="text-muted-foreground text-sm">
                {describeStorageError(error, "An unexpected error occurred.")}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <button
                    type="button"
                    onClick={retry}
                    className="tap inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
                >
                    <RotateCcw className="size-4" aria-hidden/>
                    Try again
                </button>
                {children}
            </div>
        </div>
    );
}

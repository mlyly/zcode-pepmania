"use client";

import * as React from "react";

import {RouteErrorFallback} from "@/components/app/route-error-fallback";

/**
 * Route-level error boundary (AGENTS.md §6 — never crash to a blank screen).
 * Catches render/lifecycle errors in any page below the root layout and
 * offers an in-place retry instead of a full reload.
 */
export default function AppError({error, retry}: { error: unknown; retry: () => void }) {
    React.useEffect(() => {
        console.error("[app] uncaught render error:", error);
    }, [error]);

    return <RouteErrorFallback error={error} retry={retry}/>;
}

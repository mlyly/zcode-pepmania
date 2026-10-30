"use client";

import * as React from "react";

/** No-op subscriber — the snapshot flips once, right after hydration. */
const subscribe = () => () => {
};

/**
 * `false` during server rendering and the hydration pass, `true` afterwards.
 *
 * Use it to keep locale-/clock-dependent output (formatted dates, `new Date()`,
 * `Intl` output) out of the server HTML: the server's locale, timezone and
 * clock all differ from the browser's, which otherwise trips a hydration
 * mismatch. With the static export it also prevents build-time dates from
 * being baked into the page.
 */
export function useHydrated(): boolean {
    return React.useSyncExternalStore(
        subscribe,
        () => true,
        () => false
    );
}

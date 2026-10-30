"use client";

import {WifiOff} from "lucide-react";

import {useOffline} from "next/offline";

/**
 * Compact, always-visible connectivity banner shown while the device is
 * offline. Reassurance-first: the app is fully functional, so the copy says
 * "saved locally", not "something is broken". Respects the iOS notch via
 * `env(safe-area-inset-top)` because the viewport runs edge-to-edge.
 */
export function OfflineBanner() {
    const isOffline = useOffline();

    if (!isOffline) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="animate-in fade-in slide-in-from-top-2 z-50 flex w-full items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 text-amber-800 duration-300 dark:text-amber-300"
            style={{
                paddingTop: "calc(0.375rem + env(safe-area-inset-top))",
                paddingBottom: "0.375rem",
            }}
        >
            <WifiOff className="size-3.5 shrink-0" aria-hidden/>
            <span className="text-xs font-medium">
                You’re offline — everything still works, and changes are saved on this device.
            </span>
        </div>
    );
}

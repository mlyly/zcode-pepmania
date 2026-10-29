"use client";

import {WifiOff} from "lucide-react";

import {useOffline} from "next/offline";

/**
 * Visible offline marker shown in the footer while the device has no network.
 * Disappears automatically once connectivity is restored. Uses no client JS
 * state of its own — `useOffline` re-renders on online/offline events.
 */
export function OfflineFooterMarker() {
    const isOffline = useOffline();

    if (!isOffline) return null;

    return (
        <span
            role="status"
            aria-label="Offline"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
        >
            <WifiOff className="size-3.5 shrink-0" aria-hidden="true"/>
            Offline
        </span>
    );
}

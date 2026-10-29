"use client";

import {useOffline} from "next/offline";

export function OfflineBanner() {
    const isOffline = useOffline();

    if (!isOffline) return null;

    return (
        <div
            role="status"
            className="bg-muted text-muted-foreground border-b px-4 py-1.5 text-center text-xs"
        >
            Offline — everything keeps working. Your data is stored locally.
        </div>
    );
}

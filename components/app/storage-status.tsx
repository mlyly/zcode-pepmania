"use client";

import {useEffect, useState} from "react";
import {Activity, CloudOff, Database, HardDrive, ShieldCheck} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle,} from "@/components/ui/card";
import {Progress} from "@/components/ui/progress";
import {ensureDatabase, LATEST_SCHEMA_VERSION, type MigrationResult} from "@/lib/db";
import {
    formatBytes,
    getStorageUsage,
    isStoragePersistent,
    requestPersistentStorage,
    type StorageUsage,
} from "@/lib/db/quota";

type Status =
    | { state: "loading" }
    | { state: "ready"; result: MigrationResult }
    | { state: "error"; message: string };

/** Above this share of the quota the card starts nudging the user. */
const TIGHT_QUOTA_RATIO = 0.85;

export function StorageStatus() {
    const [status, setStatus] = useState<Status>({state: "loading"});
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [persisted, setPersisted] = useState<boolean | null>(null);
    const [persistBusy, setPersistBusy] = useState(false);

    useEffect(() => {
        let active = true;
        ensureDatabase()
            .then((result) => {
                if (active) setStatus({state: "ready", result});
            })
            .catch((error: unknown) => {
                if (active) {
                    setStatus({
                        state: "error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            });
        return () => {
            active = false;
        };
    }, []);

    // Best-effort storage budget — some browsers (Safari) restrict
    // estimate(), so unknown usage must render as "no meter", never error.
    useEffect(() => {
        let active = true;
        void getStorageUsage().then((value) => {
            if (active && (value.usage !== null || value.quota !== null)) setUsage(value);
        });
        void isStoragePersistent().then((value) => {
            if (active) setPersisted(value);
        });
        return () => {
            active = false;
        };
    }, []);

    const label =
        status.state === "loading"
            ? "Opening local database…"
            : status.state === "error"
                ? "Database error"
                : `Schema v${LATEST_SCHEMA_VERSION} · migrated ${
                    status.result.from === status.result.to
                        ? "nothing (up to date)"
                        : `v${status.result.from} → v${status.result.to}`
                }`;

    const tight = usage?.ratio !== null && usage?.ratio !== undefined
        ? usage.ratio >= TIGHT_QUOTA_RATIO
        : false;

    const handleProtect = async () => {
        setPersistBusy(true);
        const granted = await requestPersistentStorage();
        setPersisted(granted === null ? null : granted);
        setPersistBusy(false);
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="size-4" aria-hidden/>
                    Local storage
                </CardTitle>
                <CardDescription>
                    All data lives in your browser (IndexedDB). No servers, no accounts,
                    no telemetry.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <ShieldCheck className="size-4" aria-hidden/>
                    {label}
                </div>
                {status.state === "error" && (
                    <p className="text-destructive">{status.message}</p>
                )}

                {usage?.ratio != null && (
                    <div className="flex flex-col gap-1.5 pt-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-muted-foreground inline-flex items-center gap-1.5">
                                <HardDrive className="size-3.5" aria-hidden/>
                                Browser storage budget
                            </span>
                            <span className="text-muted-foreground tabular-nums">
                                {usage.usage !== null && usage.quota !== null
                                    ? `${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} used`
                                    : usage.usage !== null
                                        ? `${formatBytes(usage.usage)} used`
                                        : "quota reported by the browser"}
                            </span>
                        </div>
                        <Progress
                            value={Math.min(usage.ratio * 100, 100)}
                            aria-label={`Browser storage usage: ${(usage.ratio * 100).toFixed(1)}% of quota`}
                            className={
                                tight
                                    ? "h-1.5 [&_[data-slot=progress-indicator]]:bg-amber-500 dark:[&_[data-slot=progress-indicator]]:bg-amber-400"
                                    : "h-1.5"
                            }
                        />
                        {tight && (
                            <p className="text-amber-600 dark:text-amber-400 text-xs">
                                Storage is nearly full. Export a backup you don’t need and
                                delete old logs, or clear other browser data.
                            </p>
                        )}
                    </div>
                )}

                {persisted === false && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <p className="text-muted-foreground text-xs">
                            The browser may evict this data under storage pressure.
                        </p>
                        <Button size="sm" variant="outline" onClick={() => void handleProtect()} disabled={persistBusy}>
                            {persistBusy ? "Requesting…" : "Protect storage"}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export function StatusBadges() {
    return (
        <div className="flex items-center gap-2">
            <Badge variant="outline">
                <Activity className="size-3" aria-hidden/>
                Offline-first
            </Badge>
            <Badge variant="outline">
                <CloudOff className="size-3" aria-hidden/>
                100% local
            </Badge>
        </div>
    );
}

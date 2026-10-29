"use client";

import {useEffect, useState} from "react";
import {Activity, CloudOff, Database, ShieldCheck} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {Card, CardContent, CardDescription, CardHeader, CardTitle,} from "@/components/ui/card";
import {ensureDatabase, LATEST_SCHEMA_VERSION, type MigrationResult} from "@/lib/db";

type Status =
    | { state: "loading" }
    | { state: "ready"; result: MigrationResult }
    | { state: "error"; message: string };

export function StorageStatus() {
    const [status, setStatus] = useState<Status>({state: "loading"});

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


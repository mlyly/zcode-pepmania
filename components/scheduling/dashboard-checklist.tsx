"use client";

import * as React from "react";

import {type Feedback, FeedbackLine} from "@/components/ui/feedback-line";
import {Card, CardContent, CardHeader} from "@/components/ui/card";
import {Skeleton} from "@/components/ui/skeleton";
import {storageAwareMessage} from "@/lib/db/quota";

import {TodayChecklist} from "./today-checklist";
import {useTrackerData} from "./use-tracker-data";

/**
 * Dashboard flavor of the "Today's Doses" checklist: boots the local database
 * and keeps its own copy of the data (the dashboard has no other data source).
 * Used from the home page; the /schedules manager provides its data instead.
 *
 * Boot failures stay compact (the StorageStatus card on Settings carries the
 * authoritative database message); mutation failures get their own
 * dismissible feedback line so a lost check-off is never silent.
 */
export function DashboardChecklist({manageHref}: { manageHref?: string }) {
    const {phase, data, reloading, reload} = useTrackerData();
    const [feedback, setFeedback] = React.useState<Feedback>(null);

    const onChanged = React.useCallback(() => {
        void reload();
    }, [reload]);

    const onError = React.useCallback((error: unknown, prefix: string) => {
        setFeedback({kind: "error", message: storageAwareMessage(error, prefix)});
    }, []);

    // Auto-dismiss success feedback.
    React.useEffect(() => {
        if (feedback?.kind !== "success") return;
        const timer = window.setTimeout(() => setFeedback(null), 4000);
        return () => window.clearTimeout(timer);
    }, [feedback]);

    if (phase.phase === "loading") {
        return (
            <Card aria-busy="true">
                <CardHeader className="gap-2">
                    <Skeleton className="h-5 w-32"/>
                    <Skeleton className="h-3 w-48"/>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    <Skeleton className="h-14 w-full rounded-lg"/>
                    <Skeleton className="h-14 w-full rounded-lg"/>
                    <Skeleton className="h-14 w-full rounded-lg"/>
                </CardContent>
            </Card>
        );
    }

    if (phase.phase === "error") {
        return (
            <p className="text-destructive text-xs" role="alert">
                Today’s doses could not be loaded: {phase.message}
            </p>
        );
    }

    return (
        <>
            <FeedbackLine feedback={feedback} onDismiss={() => setFeedback(null)}/>
            <TodayChecklist
                data={data}
                onChanged={onChanged}
                onError={onError}
                busy={reloading}
                manageHref={manageHref}
            />
        </>
    );
}

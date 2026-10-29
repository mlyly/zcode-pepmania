"use client";

import * as React from "react";

import {TodayChecklist} from "./today-checklist";
import {useTrackerData} from "./use-tracker-data";

/**
 * Dashboard flavor of the "Today's Doses" checklist: boots the local database
 * and keeps its own copy of the data (the dashboard has no other data source).
 * Used from the home page; the /schedules manager provides its data instead.
 *
 * `reload()` never rejects (it reports via `phase`), so failures surface here
 * as a compact inline note rather than a full error card — the dashboard's
 * StorageStatus card carries the authoritative message.
 */
export function DashboardChecklist({manageHref}: { manageHref?: string }) {
    const {phase, data, reload} = useTrackerData();

    const onChanged = React.useCallback(() => {
        void reload();
    }, [reload]);

    if (phase.phase === "error") {
        return (
            <p className="text-destructive text-xs" role="alert">
                Today’s doses could not be loaded: {phase.message}
            </p>
        );
    }

    return (
        <TodayChecklist
            data={data}
            onChanged={onChanged}
            busy={phase.phase === "loading"}
            manageHref={manageHref}
        />
    );
}

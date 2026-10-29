"use client";

import * as React from "react";

import {type DoseLog, ensureDatabase, type Medication, type Schedule} from "@/lib/db";
import {listDoseLogs, listSchedules} from "@/lib/scheduling/service";
import {listMedications} from "@/lib/medications/service";

export interface TrackerData {
    medications: Medication[];
    schedules: Schedule[];
    doseLogs: DoseLog[];
}

export type TrackerPhase =
    | { phase: "loading" }
    | { phase: "ready" }
    | { phase: "error"; message: string };

const EMPTY_DATA: TrackerData = {medications: [], schedules: [], doseLogs: []};

export interface TrackerDataState {
    phase: TrackerPhase;
    data: TrackerData;
    /** True while a background reload is in flight (after boot). */
    reloading: boolean;
    /** Re-reads all three tables (call after any mutation). */
    reload: () => Promise<void>;
}

/**
 * Client-side data source for the scheduling surfaces (dashboard checklist,
 * schedules page). Boots the database (migration pipeline) exactly once, then
 * keeps medications, schedules and dose logs in memory — a personal tracker's
 * dataset is small enough for full-table reads to stay snappy.
 *
 * Mirrors the bootstrap pattern of `MedicationsManager` (the migrations page
 * gates rendering on `ensureDatabase`).
 */
export function useTrackerData(): TrackerDataState {
    const [phase, setPhase] = React.useState<TrackerPhase>({phase: "loading"});
    const [data, setData] = React.useState<TrackerData>(EMPTY_DATA);
    // Starts true: the initial boot read counts as a reload in flight.
    const [reloading, setReloading] = React.useState(true);

    const reload = React.useCallback(async () => {
        setReloading(true);
        try {
            const [medications, schedules, doseLogs] = await Promise.all([
                listMedications(),
                listSchedules(),
                listDoseLogs(),
            ]);
            setData({medications, schedules, doseLogs});
            setPhase({phase: "ready"});
        } catch (error: unknown) {
            setPhase({
                phase: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setReloading(false);
        }
    }, []);

    React.useEffect(() => {
        let active = true;
        ensureDatabase()
            .then(() => {
                if (active) return reload();
            })
            .catch((error: unknown) => {
                if (active) {
                    setPhase({
                        phase: "error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                    setReloading(false);
                }
            });
        return () => {
            active = false;
        };
    }, [reload]);

    return {phase, data, reloading, reload};
}

/** Medications indexed by id for O(1) lookups from occurrences. */
export function medicationIndex(
    medications: Medication[]
): Map<string, Medication> {
    return new Map(medications.map((medication) => [medication.id, medication]));
}

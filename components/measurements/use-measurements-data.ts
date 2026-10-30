"use client";

import * as React from "react";

import {ensureDatabase, type MeasurementLog, type MeasurementType} from "@/lib/db";
import {listMeasurementLogs, listMeasurementTypes} from "@/lib/measurements/service";
import type {TrendRange} from "@/lib/measurements/derived";

export interface MeasurementsData {
    types: MeasurementType[];
    logs: MeasurementLog[];
}

type Phase =
    | { phase: "loading" }
    | { phase: "ready" }
    | { phase: "error"; message: string };

const EMPTY: MeasurementsData = {types: [], logs: []};

/** Lightweight UI preferences (AGENTS.md §2.1) live in LocalStorage. */
const SELECTED_KEY = "pepmania.measurements.selectedTypeId";
const RANGE_KEY = "pepmania.measurements.range";

const RANGE_VALUES: readonly TrendRange[] = ["1W", "1M", "3M", "6M", "1Y", "all"];

function readStored(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStored(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* private mode / quota — selection just won't persist. */
    }
}

export interface MeasurementsDataState {
    phase: Phase;
    data: MeasurementsData;
    reload: () => Promise<void>;
    /** Currently selected tracker (falls back to the first one). */
    selectedType: MeasurementType | null;
    selectType: (id: string) => void;
    /** Chart history window. */
    range: TrendRange;
    setRange: (range: TrendRange) => void;
    /** Readings of the selected tracker, newest first. */
    selectedLogs: MeasurementLog[];
    /** Per-type reading counts (for card chips and delete warnings). */
    logCountByType: Map<string, number>;
}

/**
 * Client-side data source for the body-measurements surface. Boots the local
 * database (migration pipeline) exactly once, then keeps tracker types and
 * readings in memory — a personal tracker's dataset is small enough for
 * full-table reads to stay snappy. Mirrors `useTrackerData`.
 */
export function useMeasurementsData(): MeasurementsDataState {
    const [phase, setPhase] = React.useState<Phase>({phase: "loading"});
    const [data, setData] = React.useState<MeasurementsData>(EMPTY);
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [range, setRangeState] = React.useState<TrendRange>("3M");

    const reload = React.useCallback(async () => {
        try {
            const [types, logs] = await Promise.all([
                listMeasurementTypes(),
                listMeasurementLogs(),
            ]);
            setData({types, logs});
            setPhase({phase: "ready"});
        } catch (error: unknown) {
            setPhase({
                phase: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }, []);

    React.useEffect(() => {
        let active = true;
        ensureDatabase()
            .then(() => {
                if (!active) return;
                // Restore the last selected tracker (validated against the
                // DB below, so a deleted id simply falls through).
                const stored = readStored(SELECTED_KEY);
                if (stored) setSelectedId(stored);
                const storedRange = readStored(RANGE_KEY);
                if (storedRange && (RANGE_VALUES as readonly string[]).includes(storedRange)) {
                    setRangeState(storedRange as TrendRange);
                }
                return reload();
            })
            .catch((error: unknown) => {
                if (active) {
                    setPhase({
                        phase: "error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [reload]);

    const selectType = React.useCallback((id: string) => {
        setSelectedId(id);
        writeStored(SELECTED_KEY, id);
    }, []);

    const setRange = React.useCallback((next: TrendRange) => {
        setRangeState(next);
        writeStored(RANGE_KEY, next);
    }, []);

    // Selection: stored id if it still exists, else the first tracker.
    const selectedType = React.useMemo<MeasurementType | null>(() => {
        if (data.types.length === 0) return null;
        return (
            data.types.find((type) => type.id === selectedId) ?? data.types[0] ?? null
        );
    }, [data.types, selectedId]);

    const logCountByType = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const log of data.logs) {
            counts.set(log.measurementTypeId, (counts.get(log.measurementTypeId) ?? 0) + 1);
        }
        return counts;
    }, [data.logs]);

    const selectedLogs = React.useMemo(() => {
        if (!selectedType) return [];
        return data.logs.filter((log) => log.measurementTypeId === selectedType.id);
    }, [data.logs, selectedType]);

    return {
        phase,
        data,
        reload,
        selectedType,
        selectType,
        range,
        setRange,
        selectedLogs,
        logCountByType,
    };
}

/** Tracker types indexed by id for O(1) lookups from logs. */
export function measurementTypeIndex(
    types: MeasurementType[]
): Map<string, MeasurementType> {
    return new Map(types.map((type) => [type.id, type]));
}

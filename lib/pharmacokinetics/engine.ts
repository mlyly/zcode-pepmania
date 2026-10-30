/**
 * High-level PK engine: resolves per-medication profiles, gathers logged and
 * scheduled doses, and produces sampled concentration curves for charting.
 *
 * Everything is synchronous and in-memory. The caller provides the already
 * loaded tables (see `useTrackerData`), so no database access or network I/O
 * happens during a rebuild — only one O(D log D + D + S) pass per medication.
 */
import type {Medication} from "@/lib/db/types";
import {localDateFromIso} from "@/lib/scheduling/dates";

import {collectDoseEvents} from "./events";
import {concentrationSeries, peakConcentration, resolvePkProfile,} from "./model";
import type {
    PkBuildInput,
    PkBuildOptions,
    PkDoseEvent,
    PkMedicationSeries,
    PkProfile,
    PkResult,
    PkWarning,
    ResolvedPkProfile,
} from "./types";

export const DEFAULT_STEP_MINUTES = 60;
export const DEFAULT_MAX_POINTS = 2000;
export const DEFAULT_PRUNE_THRESHOLD = 1e-6;
export const DEFAULT_MAX_SCHEDULED_LOOKBACK_DAYS = 3650;

/**
 * Builds concentration series for every medication that has usable elimination
 * data. Medications without a half-life/rate are skipped with a warning; one
 * bad profile never prevents the rest of the chart from rendering.
 */
export function buildPkConcentrationSeries(
    input: PkBuildInput,
    options: PkBuildOptions
): PkResult {
    const start = toEpochMs(options.start, "start");
    const end = toEpochMs(options.end, "end");
    if (end < start) {
        throw new RangeError("PK window end must not precede its start.");
    }

    const now = options.now === undefined ? Date.now() : toEpochMs(options.now, "now");
    const stepMinutes = normalizePositive(options.stepMinutes, DEFAULT_STEP_MINUTES);
    const maxPoints = Math.max(
        2,
        Math.floor(normalizePositive(options.maxPoints, DEFAULT_MAX_POINTS))
    );
    const pruneThreshold = normalizeThreshold(options.pruneThreshold);
    const maxScheduledLookbackDays = normalizePositive(
        options.maxScheduledLookbackDays,
        DEFAULT_MAX_SCHEDULED_LOOKBACK_DAYS
    );

    const warnings: PkWarning[] = [];
    const profiles = new Map<string, ResolvedPkProfile>();

    for (const medication of input.medications) {
        const merged = mergeProfile(medication, options);
        const resolved = resolvePkProfile(merged);
        if (!resolved.ok) {
            warnings.push({
                code: resolved.code,
                message: `${medication.name}: ${resolved.message}`,
                medicationId: medication.id,
                medicationName: medication.name,
            });
            continue;
        }
        profiles.set(medication.id, resolved.profile);
    }

    const collection = collectDoseEvents(
        input.medications,
        input.schedules,
        input.doseLogs,
        {
            start,
            end,
            now,
            profiles,
            includePastScheduledDoses: options.includePastScheduledDoses ?? true,
            includeFutureScheduledDoses: options.includeFutureScheduledDoses ?? true,
            pruneThreshold,
            maxScheduledLookbackDays,
        }
    );
    warnings.push(...collection.warnings);

    const eventsByMedication = new Map<string, PkDoseEvent[]>();
    for (const event of collection.events) {
        const list = eventsByMedication.get(event.medicationId);
        if (list) list.push(event);
        else eventsByMedication.set(event.medicationId, [event]);
    }

    const sampleGrid = buildSampleTimes(
        collection.events,
        start,
        end,
        stepMinutes,
        maxPoints,
        options.includeDoseTimestamps ?? true
    );
    const sampleTimes = sampleGrid.times;

    const series: PkMedicationSeries[] = [];
    for (const medication of input.medications) {
        const profile = profiles.get(medication.id);
        if (!profile) continue;

        const events = eventsByMedication.get(medication.id) ?? [];
        const values = concentrationSeries(events, sampleTimes, profile);
        const points = sampleTimes.map((timestamp, index) => ({
            timestamp,
            concentration: values[index],
        }));

        series.push({
            medicationId: medication.id,
            medicationName: medication.name,
            concentrationUnit: profile.concentrationUnit,
            profile,
            points,
            peak: peakConcentration(events, profile, start, end),
            doseCounts:
                collection.counts.get(medication.id) ?? {
                    logged: 0,
                    scheduled: 0,
                    projected: 0,
                },
        });
    }

    return {
        start,
        end,
        stepMinutes: sampleGrid.stepMinutes,
        series,
        warnings,
    };
}

/**
 * Merges layers in precedence order: default profile → medication's persisted
 * half-life → per-call override. A medication-level half-life deliberately
 * clears a default rate constant, and an override half-life clears any rate
 * beneath it, mirroring `resolvePkProfile`'s "rate wins when both are present"
 * rule.
 */
function mergeProfile(medication: Medication, options: PkBuildOptions): PkProfile {
    let profile: PkProfile = {...options.defaultProfile};

    if (medication.halfLifeHours !== undefined) {
        profile.halfLifeHours = medication.halfLifeHours;
        profile.eliminationRatePerHour = undefined;
    }

    const override = options.profiles?.[medication.id];
    if (override) {
        profile = {...profile, ...override};
        if (
            override.halfLifeHours !== undefined &&
            override.eliminationRatePerHour === undefined
        ) {
            profile.eliminationRatePerHour = undefined;
        }
    }

    return profile;
}

/**
 * Builds the shared x-axis. A uniform grid keeps charts predictable; exact
 * dose instants are folded in when the point budget allows so bolus peaks are
 * not rounded off between samples.
 */
function buildSampleTimes(
    events: readonly PkDoseEvent[],
    start: number,
    end: number,
    stepMinutes: number,
    maxPoints: number,
    includeDoseTimestamps: boolean
): { times: number[]; stepMinutes: number } {
    const span = end - start;
    if (span <= 0) return {times: [start], stepMinutes: 0};

    const desiredStep = Math.max(1, stepMinutes * 60_000);
    const desiredIntervals = Math.max(1, Math.ceil(span / desiredStep));
    const intervals = Math.max(1, Math.min(maxPoints - 1, desiredIntervals));

    const times: number[] = [];
    for (let index = 0; index <= intervals; index += 1) {
        const timestamp = start + Math.round((index * span) / intervals);
        if (times.length === 0 || times[times.length - 1] !== timestamp) {
            times.push(timestamp);
        }
    }

    const uniformStepMinutes = span / intervals / 60_000;
    if (!includeDoseTimestamps) return {times, stepMinutes: uniformStepMinutes};

    const merged = new Set(times);
    for (const event of events) {
        if (event.timestamp >= start && event.timestamp <= end) {
            merged.add(event.timestamp);
        }
    }
    if (merged.size > maxPoints) {
        return {times, stepMinutes: uniformStepMinutes};
    }

    return {
        times: [...merged].sort((a, b) => a - b),
        stepMinutes: uniformStepMinutes,
    };
}

function toEpochMs(value: Date | number | string, label: string): number {
    if (value instanceof Date) {
        const time = value.getTime();
        if (!Number.isFinite(time)) {
            throw new RangeError(`PK ${label} is not a valid date or timestamp.`);
        }
        return time;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new RangeError(`PK ${label} is not a valid date or timestamp.`);
        }
        return value;
    }

    // The app's date-only strings are local calendar days (never UTC), so
    // "2026-01-15" means local midnight just like the scheduling module.
    const parsed = localDateFromIso(value);
    if (!parsed) {
        throw new RangeError(`PK ${label} is not a valid date or timestamp.`);
    }
    return parsed.getTime();
}

function normalizePositive(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}

function normalizeThreshold(value: number | undefined): number {
    if (value === undefined) return DEFAULT_PRUNE_THRESHOLD;
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new RangeError("pruneThreshold must be between 0 and 1 (exclusive).");
    }
    return value;
}

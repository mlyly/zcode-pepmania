/**
 * Presentation helpers for the concentration dashboard.
 *
 * The PK engine works in dose-equivalent concentration (`mg-eq`, or `mg/L`
 * when a volume of distribution is supplied). These helpers keep the chart
 * layer free of math: calendar windows, display-unit conversion and the
 * wide-row shape Recharts expects for multi-medication overlays.
 */
import {addDays, startOfLocalDay} from "@/lib/scheduling/dates";

import type {PkMedicationSeries, PkSeriesPoint} from "./types";

// ---------------------------------------------------------------------------
// Time ranges
// ---------------------------------------------------------------------------

export const CHART_RANGES = [
    {id: "day", label: "Day", days: 1, stepMinutes: 10},
    {id: "week", label: "Week", days: 7, stepMinutes: 30},
    {id: "2weeks", label: "2 Weeks", days: 14, stepMinutes: 60},
    {id: "month", label: "Month", days: 30, stepMinutes: 120},
    {id: "2months", label: "2 Months", days: 60, stepMinutes: 240},
    {id: "3months", label: "3 Months", days: 90, stepMinutes: 360},
    {id: "6months", label: "6 Months", days: 180, stepMinutes: 720},
] as const;

export type ChartRangeId = (typeof CHART_RANGES)[number]["id"];
export type ChartRange = (typeof CHART_RANGES)[number];

export function chartRangeById(id: ChartRangeId): ChartRange {
    return CHART_RANGES.find((range) => range.id === id) ?? CHART_RANGES[1];
}

/**
 * Local-calendar window for a preset: whole days ending at tomorrow's local
 * midnight. Ending after "now" keeps today's remaining scheduled doses in the
 * projection instead of clipping them at the current minute.
 */
export function resolveChartWindow(
    range: ChartRange,
    now: Date = new Date()
): { start: Date; end: Date } {
    const end = startOfLocalDay(addDays(now, 1));
    const start = startOfLocalDay(addDays(now, -(range.days - 1)));
    return {start, end};
}

// ---------------------------------------------------------------------------
// Display units
// ---------------------------------------------------------------------------

export const CONCENTRATION_UNITS = ["mcg", "mg", "IU"] as const;

export type ConcentrationDisplayUnit = (typeof CONCENTRATION_UNITS)[number];

export const CONCENTRATION_UNIT_META: Record<
    ConcentrationDisplayUnit,
    { label: string; suffix: string; description: string }
> = {
    mcg: {
        label: "mcg",
        suffix: "mcg-eq",
        description: "Micrograms, dose-equivalent",
    },
    mg: {
        label: "mg",
        suffix: "mg-eq",
        description: "Milligrams, dose-equivalent",
    },
    IU: {
        label: "IU",
        suffix: "IU-eq",
        description: "International units (1 IU = 1 mg fallback)",
    },
};

/**
 * Converts an engine concentration in `mg-eq` to the display unit. `IU` has
 * no universal mass ratio, so it follows the app-wide 1:1 fallback (the chart
 * surfaces that caveat whenever IU is selected).
 */
export function convertConcentration(
    concentrationMgEq: number,
    unit: ConcentrationDisplayUnit
): number {
    return unit === "mcg" ? concentrationMgEq * 1000 : concentrationMgEq;
}

export function concentrationSuffix(unit: ConcentrationDisplayUnit): string {
    return CONCENTRATION_UNIT_META[unit].suffix;
}

const compactFormatters = new Map<number, Intl.NumberFormat>();

function formatterFor(maximumFractionDigits: number): Intl.NumberFormat {
    const cached = compactFormatters.get(maximumFractionDigits);
    if (cached) return cached;
    const formatter = new Intl.NumberFormat(undefined, {
        maximumFractionDigits,
        minimumFractionDigits: 0,
    });
    compactFormatters.set(maximumFractionDigits, formatter);
    return formatter;
}

/** Trims noise while keeping very small mg-equivalent values readable. */
export function formatConcentrationValue(value: number): string {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const digits =
        abs === 0
            ? 0
            : abs >= 100
                ? 0
                : abs >= 10
                    ? 1
                    : abs >= 1
                        ? 2
                        : abs >= 0.1
                            ? 3
                            : abs >= 0.01
                                ? 4
                                : abs >= 0.001
                                    ? 5
                                    : 6;
    return formatterFor(digits).format(value);
}

export function formatConcentration(
    value: number,
    unit: ConcentrationDisplayUnit
): string {
    return `${formatConcentrationValue(value)} ${concentrationSuffix(unit)}`;
}

/** Axis label for the current display unit. */
export function concentrationAxisLabel(unit: ConcentrationDisplayUnit): string {
    return concentrationSuffix(unit);
}

// ---------------------------------------------------------------------------
// Chart row shaping
// ---------------------------------------------------------------------------

/** Stable Recharts data key for a medication (ids are UUIDs, but be safe). */
export function seriesKey(medicationId: string): string {
    return `med_${medicationId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export interface ConcentrationChartRow {
    timestamp: number;

    [key: string]: number;
}

/**
 * Merges per-medication series into wide rows. The engine samples every
 * series on one shared grid, so points align by index; a missing point falls
 * back to the nearest earlier sample (or 0) instead of breaking the row.
 */
export function buildConcentrationChartRows(
    series: readonly PkMedicationSeries[],
    unit: ConcentrationDisplayUnit
): ConcentrationChartRow[] {
    if (series.length === 0) return [];

    const timestamps = new Set<number>();
    for (const medication of series) {
        for (const point of medication.points) timestamps.add(point.timestamp);
    }

    const sorted = [...timestamps].sort((a, b) => a - b);
    const cursors = new Map<string, number>();
    const rows: ConcentrationChartRow[] = [];

    for (const timestamp of sorted) {
        const row: ConcentrationChartRow = {timestamp};
        for (const medication of series) {
            const key = seriesKey(medication.medicationId);
            let index = cursors.get(medication.medicationId) ?? 0;
            while (
                index + 1 < medication.points.length &&
                medication.points[index + 1].timestamp <= timestamp
                ) {
                index += 1;
            }
            const point = medication.points[index];
            row[key] =
                point && point.timestamp <= timestamp
                    ? convertConcentration(point.concentration, unit)
                    : 0;
            cursors.set(medication.medicationId, index);
        }
        rows.push(row);
    }

    return rows;
}

/**
 * Concentration at (or immediately before) an instant, using the already
 * sorted sample points. Used for the "combined right now" summary.
 */
export function concentrationAtInstant(
    points: readonly PkSeriesPoint[],
    atMs: number
): number {
    if (points.length === 0) return 0;

    let low = 0;
    let high = points.length - 1;
    let best = 0;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (points[middle].timestamp <= atMs) {
            best = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return points[best].concentration;
}

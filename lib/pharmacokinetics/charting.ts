/**
 * Presentation helpers for the concentration dashboard.
 *
 * The PK engine works in dose-equivalent concentration (`mg-eq`, or `mg/L`
 * when a volume of distribution is supplied). These helpers keep the chart
 * layer free of math: the three-slot time window, display-unit conversion
 * and the wide-row shape Recharts expects for multi-medication overlays.
 */
import type {PkMedicationSeries, PkResult, PkSeriesPoint,} from "./types";

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
 * Three-slot time window for a preset. The total span (`range.days`) is split
 * into three equal parts and "now" is pinned to the start of the last slot:
 * two slots of history behind the Now line, one slot of projection ahead of
 * it. This gives scheduled future doses a stable region to render in and
 * keeps the layout at a fixed 2/3 – 1/3 ratio for every range.
 */
export function resolveChartWindow(
    range: ChartRange,
    now: Date = new Date()
): { start: Date; end: Date } {
    const nowMs = now.getTime();
    const spanMs = range.days * 24 * 3_600_000;
    return {
        start: new Date(nowMs - (2 / 3) * spanMs),
        end: new Date(nowMs + (1 / 3) * spanMs),
    };
}

/**
 * The boundary between the two history slots — one-third of the window in
 * (i.e. halfway between the window start and now). The Now line itself is the
 * boundary between the second history slot and the projection slot.
 */
export function historySlotSplitMs(startMs: number, nowMs: number): number {
    return startMs + (nowMs - startMs) / 2;
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

/**
 * Formats a concentration already expressed in `unit` (convert first with
 * `convertConcentration` when starting from the engine's mg-equivalent base).
 */
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

// ---------------------------------------------------------------------------
// Upcoming (projected) doses
// ---------------------------------------------------------------------------

export interface UpcomingDose {
    /** Dose event id (`sched:<occurrence key>`). */
    id: string;
    medicationId: string;
    medicationName: string;
    /** Epoch ms the dose enters the body. */
    timestamp: number;
    /** Administered amount in the engine's mg base. */
    amountMg: number;
    /** Modeled concentration right at (after) the dose, in the display unit. */
    level: number;
}

/**
 * Scheduled doses that lie after the current now-instant and inside the
 * chart window — exactly what lands in the projection slot ahead of the Now
 * line. The engine marks occurrences past its `now` option as projected.
 */
export function collectUpcomingDoses(
    result: PkResult,
    options: {
        /** Window start (>= now instant in practice). */
        fromMs: number;
        toMs: number;
        unit: ConcentrationDisplayUnit;
        /** Safety cap on chart markers. Default 120. */
        max?: number;
    }
): UpcomingDose[] {
    const seriesById = new Map(
        result.series.map((series) => [series.medicationId, series])
    );
    const upcoming: UpcomingDose[] = [];

    for (const event of result.events) {
        if (!event.projected) continue;
        if (event.timestamp < options.fromMs || event.timestamp > options.toMs) {
            continue;
        }
        const series = seriesById.get(event.medicationId);
        if (!series) continue;
        upcoming.push({
            id: event.id,
            medicationId: event.medicationId,
            medicationName: series.medicationName,
            timestamp: event.timestamp,
            amountMg: event.amountMg,
            level: convertConcentration(
                concentrationAtInstant(series.points, event.timestamp),
                options.unit
            ),
        });
    }

    const max = options.max ?? 120;
    return upcoming.length > max ? upcoming.slice(0, max) : upcoming;
}

/** Formats a dose amount (mg base) in the display unit, e.g. `250 mcg`. */
export function formatDoseAmount(
    amountMg: number,
    unit: ConcentrationDisplayUnit
): string {
    return `${formatConcentrationValue(convertConcentration(amountMg, unit))} ${unit}`;
}

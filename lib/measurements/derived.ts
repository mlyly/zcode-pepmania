/**
 * Pure derivations for the body-measurements module: value parsing
 * (numeric vs "systolic/diastolic"), compact formatting, per-range
 * filtering, summary stats and Recharts row building. No DB or React
 * dependencies so it is trivially testable (see
 * `scripts/measurements-smoke.ts`).
 */
import type {MeasurementLog, MeasurementType, MeasurementValueKind} from "@/lib/db/types";
import {formatNumber} from "@/lib/units";

import {BLOOD_PRESSURE_PATTERN} from "./constants";

// ---------------------------------------------------------------------------
// Kind resolution & value parsing
// ---------------------------------------------------------------------------

/** Effective kind of a stored type — pre-v5 rows without `valueKind` are numeric. */
export function effectiveKind(
    type: Pick<MeasurementType, "valueKind"> | undefined | null
): MeasurementValueKind {
    return type?.valueKind === "blood_pressure" ? "blood_pressure" : "numeric";
}

export interface BloodPressureValue {
    systolic: number;
    diastolic: number;
}

export type ParsedMeasurementValue =
    | { kind: "numeric"; value: number }
    | { kind: "blood_pressure"; value: BloodPressureValue };

/**
 * Parses a stored log value against its type's kind. Unparseable rows (e.g.
 * free text on a numeric tracker) return null and are skipped in stats and
 * charts rather than crashing them.
 */
export function parseMeasurementValue(
    raw: number | string,
    kind: MeasurementValueKind
): ParsedMeasurementValue | null {
    if (kind === "blood_pressure") {
        const match = BLOOD_PRESSURE_PATTERN.exec(String(raw).trim());
        if (!match) return null;
        const systolic = Number(match[1]);
        const diastolic = Number(match[2]);
        if (systolic <= diastolic) return null;
        return {kind: "blood_pressure", value: {systolic, diastolic}};
    }
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(value) && value > 0
        ? {kind: "numeric", value}
        : null;
}

/**
 * Serializes a BP pair into the stored string form ("120/80"); components
 * must already be validated integers with systolic > diastolic.
 */
export function bloodPressureToString({systolic, diastolic}: BloodPressureValue): string {
    return `${systolic}/${diastolic}`;
}

/**
 * Builds the stored value for a validated log: number for numeric trackers,
 * "sys/dia" string for blood pressure. Returns null when the pieces don't
 * fit the type's kind (defense in depth — the form already validated).
 */
export function toStoredValue(
    kind: MeasurementValueKind,
    numeric: number | null,
    bloodPressure: BloodPressureValue | null
): number | string | null {
    if (kind === "blood_pressure") {
        return bloodPressure ? bloodPressureToString(bloodPressure) : null;
    }
    return numeric ?? null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** e.g. "72.4 kg" or "120/80 mmHg" — unit omitted when blank. */
export function formatMeasurementValue(
    parsed: ParsedMeasurementValue,
    unit: string
): string {
    const withUnit = (text: string) => (unit ? `${text} ${unit}` : text);
    if (parsed.kind === "blood_pressure") {
        return withUnit(`${parsed.value.systolic}/${parsed.value.diastolic}`);
    }
    return withUnit(formatNumber(parsed.value));
}

/** Formats a stored value defensively (falls back to the raw text). */
export function formatStoredValue(
    raw: number | string,
    kind: MeasurementValueKind,
    unit: string
): string {
    const parsed = parseMeasurementValue(raw, kind);
    return parsed ? formatMeasurementValue(parsed, unit) : String(raw);
}

/** Signed delta for display: "+0.3", "−2", "0". */
export function formatDelta(delta: number): string {
    const rounded = Math.round(delta * 100) / 100;
    if (rounded === 0) return "0";
    const abs = formatNumber(Math.abs(rounded));
    return rounded > 0 ? `+${abs}` : `−${abs}`;
}

// ---------------------------------------------------------------------------
// Ranges & filtering
// ---------------------------------------------------------------------------

export type TrendRange = "1W" | "1M" | "3M" | "6M" | "1Y" | "all";

export const TREND_RANGES: readonly TrendRange[] = ["1W", "1M", "3M", "6M", "1Y", "all"];

const RANGE_DAYS: Record<Exclude<TrendRange, "all">, number> = {
    "1W": 7,
    "1M": 30,
    "3M": 91,
    "6M": 182,
    "1Y": 365,
};

/** Start instant (ms) of the range, or null for "all". */
export function rangeStartMs(range: TrendRange, nowMs = Date.now()): number | null {
    if (range === "all") return null;
    return nowMs - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
}

/**
 * Logs for one type within the range, newest first. `logs` is expected in
 * newest-first order (as returned by the service) but is re-sorted here so
 * callers can pass any order.
 */
export function filterLogsForRange(
    logs: MeasurementLog[],
    typeId: string,
    range: TrendRange,
    nowMs = Date.now()
): MeasurementLog[] {
    const start = rangeStartMs(range, nowMs);
    return logs
        .filter((log) => log.measurementTypeId === typeId)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .filter((log) => start === null || new Date(log.timestamp).getTime() >= start);
}

// ---------------------------------------------------------------------------
// Summary stats
// ---------------------------------------------------------------------------

export interface NumericSummary {
    count: number;
    latest: number;
    /** Change of the latest reading vs the previous one (null when < 2 logs). */
    delta: number | null;
    min: number;
    max: number;
    avg: number;
}

function summarize(valuesOldestFirst: number[]): NumericSummary | null {
    const count = valuesOldestFirst.length;
    if (count === 0) return null;
    const latest = valuesOldestFirst[count - 1];
    const previous = count > 1 ? valuesOldestFirst[count - 2] : null;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const value of valuesOldestFirst) {
        if (value < min) min = value;
        if (value > max) max = value;
        sum += value;
    }
    return {
        count,
        latest,
        delta: previous === null ? null : latest - previous,
        min,
        max,
        avg: sum / count,
    };
}

/**
 * Summary for the filtered (newest-first) logs of one tracker: single
 * summary for numeric trackers, one per component for blood pressure.
 */
export type MeasurementSummary =
    | { kind: "numeric"; stats: NumericSummary | null }
    | { kind: "blood_pressure"; systolic: NumericSummary | null; diastolic: NumericSummary | null };

export function summarizeLogs(
    logsNewestFirst: MeasurementLog[],
    kind: MeasurementValueKind
): MeasurementSummary {
    // Charts and stats read chronologically; the service hands newest-first.
    const oldestFirst = [...logsNewestFirst].reverse();
    if (kind === "blood_pressure") {
        const systolic: number[] = [];
        const diastolic: number[] = [];
        for (const log of oldestFirst) {
            const parsed = parseMeasurementValue(log.value, "blood_pressure");
            if (!parsed || parsed.kind !== "blood_pressure") continue;
            systolic.push(parsed.value.systolic);
            diastolic.push(parsed.value.diastolic);
        }
        return {
            kind: "blood_pressure",
            systolic: summarize(systolic),
            diastolic: summarize(diastolic),
        };
    }
    const values: number[] = [];
    for (const log of oldestFirst) {
        const parsed = parseMeasurementValue(log.value, "numeric");
        if (parsed && parsed.kind === "numeric") values.push(parsed.value);
    }
    return {kind: "numeric", stats: summarize(values)};
}

// ---------------------------------------------------------------------------
// Chart rows
// ---------------------------------------------------------------------------

export interface TrendChartRow {
    /** Local instant (ms) — numeric so the x-axis can use a time scale. */
    timestamp: number;
    value?: number;
    systolic?: number;
    diastolic?: number;
}

/**
 * Chronological chart rows (oldest → newest, required by the line plot).
 * Unparseable values are skipped; same-instant logs collapse into one row.
 */
export function buildTrendRows(
    logsNewestFirst: MeasurementLog[],
    kind: MeasurementValueKind
): TrendChartRow[] {
    const byInstant = new Map<number, TrendChartRow>();
    for (const log of [...logsNewestFirst].sort(
        (a, b) => a.timestamp.localeCompare(b.timestamp)
    )) {
        const parsed = parseMeasurementValue(log.value, kind);
        if (!parsed) continue;
        const timestamp = new Date(log.timestamp).getTime();
        if (Number.isNaN(timestamp)) continue;
        const row = byInstant.get(timestamp) ?? {timestamp};
        if (parsed.kind === "blood_pressure") {
            row.systolic = parsed.value.systolic;
            row.diastolic = parsed.value.diastolic;
        } else {
            row.value = parsed.value;
        }
        byInstant.set(timestamp, row);
    }
    return [...byInstant.values()].sort((a, b) => a.timestamp - b.timestamp);
}

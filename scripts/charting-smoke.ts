/**
 * Smoke test for the concentration-dashboard charting helpers, runnable in
 * Node:
 *
 *   npx tsx scripts/charting-smoke.ts
 *
 * Covers: calendar time windows (inclusive of the projection tail), display
 * unit conversion (mcg/mg/IU), wide-row chart shaping, instant lookups for
 * the "combined now" stat, and end-to-end rendering through the PK engine.
 */
import type {DoseLog, Medication} from "../lib/db/types";
import {
    buildConcentrationChartRows,
    CHART_RANGES,
    chartRangeById,
    concentrationAtInstant,
    concentrationSuffix,
    convertConcentration,
    formatConcentration,
    formatConcentrationValue,
    resolveChartWindow,
    seriesKey,
} from "../lib/pharmacokinetics/charting";
import {buildPkConcentrationSeries} from "../lib/pharmacokinetics/engine";

let failed = false;

function check(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`✓ ${label}`);
    } else {
        console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
        failed = true;
    }
}

function near(actual: number, expected: number, tolerance = 1e-9): boolean {
    return Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

/** Build a LOCAL calendar instant (m 1-based). */
function d(year: number, month: number, day: number, hour = 0, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const H = 3_600_000;
const NOW = d(2026, 1, 15, 10, 30);

function main() {
    // =============================================================== ranges
    check(
        "every requested label has a preset",
        CHART_RANGES.map((r) => r.label).join(",") ===
        "Day,Week,2 Weeks,Month,2 Months,3 Months,6 Months"
    );
    const day = chartRangeById("day");
    const six = chartRangeById("6months");
    check("unknown ids fall back to the week preset", chartRangeById("nope" as never).id === "week");

    const dayWindow = resolveChartWindow(day, NOW);
    check(
        "day window covers today through tomorrow's local midnight",
        dayWindow.start.getTime() === d(2026, 1, 15).getTime() &&
        dayWindow.end.getTime() === d(2026, 1, 16).getTime()
    );
    const weekWindow = resolveChartWindow(chartRangeById("week"), NOW);
    check(
        "week window spans 7 local calendar days ending tomorrow",
        weekWindow.start.getTime() === d(2026, 1, 9).getTime() &&
        weekWindow.end.getTime() === d(2026, 1, 16).getTime()
    );
    const sixWindow = resolveChartWindow(six, NOW);
    check(
        "6-month window spans 180 local days",
        Math.round((sixWindow.end.getTime() - sixWindow.start.getTime()) / (24 * H)) === 180
    );

    // =============================================================== units
    check("mg passes through", near(convertConcentration(2.5, "mg"), 2.5));
    check("mcg multiplies by 1000", near(convertConcentration(2.5, "mcg"), 2500));
    check("IU follows the 1:1 fallback", near(convertConcentration(2.5, "IU"), 2.5));
    check("suffixes are dose-equivalent", concentrationSuffix("mcg") === "mcg-eq" && concentrationSuffix("IU") === "IU-eq");

    check(
        "small values keep precision, large values stay compact",
        formatConcentrationValue(0.000123) === "0.000123" &&
        formatConcentrationValue(1234.56) === "1,235" &&
        formatConcentration(convertConcentration(0.25, "mcg"), "mcg") === "250 mcg-eq"
    );

    // ============================================================ row merge
    const t0 = NOW.getTime();
    const points = (value: number) => [
        {timestamp: t0, concentration: value},
        {timestamp: t0 + H, concentration: value / 2},
    ];
    const fake = (id: string, name: string, value: number) =>
        ({
            medicationId: id,
            medicationName: name,
            concentrationUnit: "mg-eq",
            points: points(value),
            peak: {timestamp: t0, concentration: value},
            doseCounts: {logged: 1, scheduled: 0, projected: 0},
            profile: {
                halfLifeHours: 8,
                eliminationRatePerHour: Math.LN2 / 8,
                bioavailability: 1,
                concentrationPerMg: 1,
                concentrationUnit: "mg-eq",
            },
        }) as never;

    const rowsMg = buildConcentrationChartRows(
        [fake("a", "Alpha", 2), fake("b", "Bravo", 1)],
        "mg"
    );
    check(
        "series merge into one wide row per sample time",
        rowsMg.length === 2 &&
        rowsMg[0][seriesKey("a")] === 2 &&
        rowsMg[0][seriesKey("b")] === 1 &&
        rowsMg[1][seriesKey("a")] === 1
    );
    const rowsMcg = buildConcentrationChartRows(
        [fake("a", "Alpha", 2)],
        "mcg"
    );
    check(
        "unit toggle rescales every row value",
        rowsMcg[0][seriesKey("a")] === 2000 && rowsMcg[1][seriesKey("a")] === 1000
    );

    // ========================================================= instant look
    const sample = [
        {timestamp: t0, concentration: 4},
        {timestamp: t0 + H, concentration: 2},
        {timestamp: t0 + 2 * H, concentration: 1},
    ];
    check(
        "instant lookup takes the last sample at or before the query",
        concentrationAtInstant(sample, t0 + 90 * 60_000) === 2 &&
        concentrationAtInstant(sample, t0) === 4 &&
        concentrationAtInstant(sample, t0 - 1) === 4 &&
        concentrationAtInstant([], t0) === 0
    );

    // ================================================== end-to-end with PK
    const medication: Medication = {
        id: "m1",
        name: "Testide",
        type: "peptide",
        unit: "mg",
        inventory: {currentQuantity: 5, vialCount: 1, containerSize: 5},
        halfLifeHours: 24,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
    };
    const logs: DoseLog[] = [
        {
            id: "l1",
            medicationId: medication.id,
            doseAmount: 1,
            unit: "mg",
            timestamp: d(2026, 1, 14, 9).toISOString(),
        },
    ];
    const result = buildPkConcentrationSeries(
        {medications: [medication], schedules: [], doseLogs: logs},
        {
            start: weekWindow.start,
            end: weekWindow.end,
            now: NOW,
            stepMinutes: chartRangeById("week").stepMinutes,
        }
    );
    const e2e = buildConcentrationChartRows(result.series, "mcg");
    check(
        "engine output feeds the chart row builder",
        e2e.length === result.series[0].points.length &&
        e2e.every((row) => Number.isFinite(row[seriesKey(medication.id)]))
    );
    const decay = e2e.find((row) => row.timestamp >= d(2026, 1, 15, 9).getTime());
    check(
        "a day-old 1 mg dose reads as ≈500 mcg-equivalent at t½=24h",
        decay !== undefined && near(decay[seriesKey(medication.id)], 500, 0.01),
        String(decay?.[seriesKey(medication.id)])
    );

    // ---------------------------------------------------------------- summary
    if (failed) {
        console.error("\nCharting smoke test FAILED");
        process.exit(1);
    }
    console.log("\nCharting smoke test passed");
}

main();

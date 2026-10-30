/**
 * Smoke test for the pharmacokinetic concentration engine, runnable in Node:
 *
 *   npx tsx scripts/pk-smoke.ts
 *
 * Covers: profile resolution (half-life ↔ rate, bioavailability, volume of
 * distribution), closed-form superposition, the streaming series builder,
 * exact peaks, scheduled-dose synthesis (past/future/projected), log dedupe
 * (pinned + legacy same-day), unit conversion (mcg/mL/IU), wash-out pruning,
 * sampling budgets, multi-medication overlays and a large-dataset timing check.
 */
import type {DoseLog, DoseUnit, Medication, Schedule} from "../lib/db/types";
import {
    buildPkConcentrationSeries,
    collectDoseEvents,
    concentrationAt,
    concentrationSeries,
    doseAmountToMg,
    expandSchedulesChunked,
    halfLifeToRate,
    lookbackHours,
    peakConcentration,
    type PkDoseEvent,
    type PkMedicationSeries,
    rateToHalfLife,
    remainingFraction,
    resolvePkProfile,
} from "../lib/pharmacokinetics";

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

/** Build a LOCAL calendar instant (y/m/d 1-based, h/m 24h). */
function d(year: number, month: number, day: number, hour = 0, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const H = 3_600_000;
const NOW = d(2026, 1, 15, 10, 30);

function medication(
    id: string,
    halfLifeHours: number | undefined,
    overrides: Partial<Medication> = {}
): Medication {
    return {
        id,
        name: `Med ${id}`,
        type: "peptide",
        unit: "mg",
        inventory: {currentQuantity: 10, vialCount: 2, containerSize: 5},
        halfLifeHours,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        ...overrides,
    };
}

function doseLog(
    id: string,
    medicationId: string,
    doseAmount: number,
    unit: DoseUnit,
    timestamp: number | Date | string,
    overrides: Partial<DoseLog> = {}
): DoseLog {
    return {
        id,
        medicationId,
        doseAmount,
        unit,
        timestamp:
            timestamp instanceof Date
                ? timestamp.toISOString()
                : typeof timestamp === "number"
                    ? new Date(timestamp).toISOString()
                    : timestamp,
        ...overrides,
    };
}

function schedule(
    id: string,
    medicationId: string,
    overrides: Partial<Schedule> = {}
): Schedule {
    return {
        id,
        medicationId,
        doseAmount: 1,
        unit: "mg",
        frequencyType: "daily",
        timeOfDay: "08:00",
        startDate: "2026-01-14",
        active: true,
        ...overrides,
    };
}

function event(
    id: string,
    timestamp: number,
    amountMg: number,
    medicationId = "m1"
): PkDoseEvent {
    return {id, medicationId, kind: "logged", timestamp, amountMg};
}

function pointAt(series: PkMedicationSeries, timestamp: number): number | null {
    const point = series.points.find((candidate) => candidate.timestamp === timestamp);
    return point ? point.concentration : null;
}

function main() {
    // ======================================================= profile resolution
    const oneHour = resolvePkProfile({halfLifeHours: 1});
    check("a 1 h half-life resolves", oneHour.ok);
    if (oneHour.ok) {
        check(
            "half-life converts to λ = ln 2",
            near(oneHour.profile.eliminationRatePerHour, Math.LN2) &&
            near(oneHour.profile.halfLifeHours, 1)
        );
        check(
            "no volume → mg-equivalent unit, F defaults to 1",
            oneHour.profile.concentrationUnit === "mg-eq" &&
            oneHour.profile.concentrationPerMg === 1 &&
            oneHour.profile.bioavailability === 1
        );
        check(
            "wash-out lookback is ≈ 20 half-lives at 1e-6",
            near(lookbackHours(oneHour.profile), -Math.log(1e-6) / Math.LN2, 1e-9) &&
            near(lookbackHours(oneHour.profile), 19.93, 0.01)
        );
        check(
            "remainingFraction halves after one half-life",
            near(remainingFraction(oneHour.profile, 1), 0.5)
        );
    }

    check(
        "halfLifeToRate / rateToHalfLife round-trip",
        near(rateToHalfLife(halfLifeToRate(8)), 8)
    );

    const explicitRate = resolvePkProfile({
        halfLifeHours: 100,
        eliminationRatePerHour: 0.5,
    });
    check(
        "an explicit elimination rate wins over half-life",
        explicitRate.ok && near(explicitRate.profile.eliminationRatePerHour, 0.5) &&
        near(explicitRate.profile.halfLifeHours, Math.LN2 / 0.5)
    );

    const dosed = resolvePkProfile({
        halfLifeHours: 4,
        bioavailability: 0.5,
        volumeOfDistributionL: 10,
    });
    check(
        "bioavailability and volume produce mg/L (F/V = 0.05)",
        dosed.ok &&
        dosed.profile.concentrationUnit === "mg/L" &&
        near(dosed.profile.concentrationPerMg, 0.05)
    );

    for (const [label, profile] of [
        ["missing elimination data", {}],
        ["zero half-life", {halfLifeHours: 0}],
        ["negative rate", {eliminationRatePerHour: -1}],
        ["bioavailability above 1", {halfLifeHours: 1, bioavailability: 1.5}],
        ["zero volume", {halfLifeHours: 1, volumeOfDistributionL: 0}],
    ] as const) {
        check(`invalid profile rejected: ${label}`, !resolvePkProfile(profile).ok);
    }

    // ===================================================== core concentration
    const t0 = d(2026, 1, 15).getTime();
    const single = [event("d1", t0, 1)];
    if (!oneHour.ok) throw new Error("profile failed");

    check(
        "single dose: C(0) = dose",
        near(concentrationAt(single, t0, oneHour.profile), 1)
    );
    check(
        "single dose: C(1 h) = 0.5",
        near(concentrationAt(single, t0 + H, oneHour.profile), 0.5)
    );
    check(
        "single dose: C(2 h) = 0.25",
        near(concentrationAt(single, t0 + 2 * H, oneHour.profile), 0.25)
    );
    check(
        "concentration is zero before the dose",
        concentrationAt(single, t0 - 1, oneHour.profile) === 0
    );

    const samples = [t0, t0 + H / 2, t0 + H, t0 + 2 * H];
    const curve = concentrationSeries(single, samples, oneHour.profile);
    check(
        "streaming series matches the closed form at each sample",
        near(curve[0], 1) &&
        near(curve[1], Math.SQRT1_2) &&
        near(curve[2], 0.5) &&
        near(curve[3], 0.25)
    );

    // Superposition: 1 mg at t0 + 1 mg at t0+1h.
    const two = [event("d1", t0, 1), event("d2", t0 + H, 1)];
    check(
        "superposition: post-dose at 1 h = 1.5",
        near(concentrationAt(two, t0 + H, oneHour.profile), 1.5)
    );
    check(
        "superposition: post-dose at 2 h = 0.75",
        near(concentrationAt(two, t0 + 2 * H, oneHour.profile), 0.75)
    );
    check(
        "series builder handles a dose exactly on a sample instant",
        near(concentrationSeries(two, [t0, t0 + H, t0 + 2 * H], oneHour.profile)[1], 1.5)
    );
    check(
        "unsorted doses are still evaluated correctly",
        near(concentrationAt([two[1], two[0]], t0 + H, oneHour.profile), 1.5)
    );

    check(
        "exact peak lands on the post-dose maximum",
        (() => {
            const peak = peakConcentration(two, oneHour.profile, t0, t0 + 3 * H);
            return peak.timestamp === t0 + H && near(peak.concentration, 1.5);
        })()
    );

    if (dosed.ok) {
        check(
            "volume + bioavailability scale the curve by F/V",
            near(concentrationAt(single, t0, dosed.profile), 0.05)
        );
    }

    // ==================================================== dose-event collection
    const med = medication("m1", 8);
    const daily = schedule("s1", med.id, {startDate: "2026-01-14"});
    const pinnedAt = d(2026, 1, 15, 8).toISOString();
    const logs = [doseLog("l1", med.id, 1, "mg", d(2026, 1, 15, 8), {
        scheduleId: daily.id,
        scheduledFor: pinnedAt,
    })];

    const chartStart = d(2026, 1, 14).getTime();
    const chartEnd = d(2026, 1, 16, 12).getTime();
    const profiles = new Map([
        [med.id, resolvePkProfile({halfLifeHours: 8})],
    ]);
    const flatProfiles = new Map(
        [...profiles].map(([id, resolved]) => {
            if (!resolved.ok) throw new Error("profile failed");
            return [id, resolved.profile] as const;
        })
    );

    const collected = collectDoseEvents(
        [med],
        [daily],
        logs,
        {
            start: chartStart,
            end: chartEnd,
            now: NOW.getTime(),
            profiles: flatProfiles,
            includePastScheduledDoses: true,
            includeFutureScheduledDoses: true,
            pruneThreshold: 1e-6,
            maxScheduledLookbackDays: 3650,
        }
    );
    check(
        "collection includes past scheduled, the log, and the future projection",
        collected.events.length === 3 &&
        collected.events.filter((e) => e.kind === "logged").length === 1 &&
        collected.events.filter((e) => e.kind === "scheduled").length === 2 &&
        collected.events.filter((e) => e.projected).length === 1,
        JSON.stringify(collected.events.map((e) => [e.kind, e.projected, new Date(e.timestamp).toISOString()]))
    );
    check(
        "the pinned log suppresses its own scheduled occurrence",
        !collected.events.some(
            (e) => e.kind === "scheduled" &&
                e.timestamp === d(2026, 1, 15, 8).getTime()
        )
    );
    check(
        "counts split logged / scheduled / projected",
        collected.counts.get(med.id)?.logged === 1 &&
        collected.counts.get(med.id)?.scheduled === 2 &&
        collected.counts.get(med.id)?.projected === 1
    );

    const pastOff = collectDoseEvents(
        [med],
        [daily],
        logs,
        {
            start: chartStart,
            end: chartEnd,
            now: NOW.getTime(),
            profiles: flatProfiles,
            includePastScheduledDoses: false,
            includeFutureScheduledDoses: true,
            pruneThreshold: 1e-6,
            maxScheduledLookbackDays: 3650,
        }
    );
    check(
        "includePastScheduledDoses=false drops the missed past occurrence",
        pastOff.counts.get(med.id)?.scheduled === 1 &&
        pastOff.counts.get(med.id)?.projected === 1
    );

    const futureOff = collectDoseEvents(
        [med],
        [daily],
        logs,
        {
            start: chartStart,
            end: chartEnd,
            now: NOW.getTime(),
            profiles: flatProfiles,
            includePastScheduledDoses: true,
            includeFutureScheduledDoses: false,
            pruneThreshold: 1e-6,
            maxScheduledLookbackDays: 3650,
        }
    );
    check(
        "includeFutureScheduledDoses=false drops the projection",
        futureOff.counts.get(med.id)?.scheduled === 1 &&
        futureOff.counts.get(med.id)?.projected === 0
    );

    // Legacy logs (no scheduledFor) match their occurrence by schedule + day.
    const legacySchedule = schedule("s2", med.id, {startDate: "2026-01-13"});
    const legacyLog = doseLog("l2", med.id, 1, "mg", d(2026, 1, 13, 9), {
        scheduleId: legacySchedule.id,
    });
    const legacy = collectDoseEvents(
        [med],
        [legacySchedule],
        [legacyLog],
        {
            start: d(2026, 1, 13).getTime(),
            end: d(2026, 1, 14).getTime(),
            now: NOW.getTime(),
            profiles: flatProfiles,
            includePastScheduledDoses: true,
            includeFutureScheduledDoses: true,
            pruneThreshold: 1e-6,
            maxScheduledLookbackDays: 3650,
        }
    );
    check(
        "legacy same-day log suppresses the schedule occurrence",
        legacy.events.length === 1 &&
        legacy.events[0].kind === "logged" &&
        legacy.counts.get(med.id)?.scheduled === 0
    );

    // ======================================================== unit conversions
    check(
        "mcg doses convert to mg for the model",
        (() => {
            const mass = doseAmountToMg(250, "mcg", med);
            return mass !== null && near(mass.amountMg, 0.25) && !mass.iuFallback;
        })()
    );
    check(
        "IU doses convert 1:1 and flag the fallback",
        (() => {
            const mass = doseAmountToMg(10, "IU", med);
            return mass !== null && near(mass.amountMg, 10) && mass.iuFallback;
        })()
    );
    const reconstituted = medication("m2", 12, {
        unit: "mL",
        reconstitution: {
            vialQuantity: 5,
            vialQuantityUnit: "mg",
            bacWaterAmountMl: 2,
        },
    });
    check(
        "mL doses convert through the reconstitution concentration",
        (() => {
            const mass = doseAmountToMg(0.2, "mL", reconstituted);
            return mass !== null && near(mass.amountMg, 0.5);
        })()
    );
    check(
        "mL without a reconstitution cannot be converted",
        doseAmountToMg(0.2, "mL", med) === null
    );

    // ============================================================ full engine
    const engineInput = {
        medications: [med],
        schedules: [daily],
        doseLogs: logs,
    };
    const result = buildPkConcentrationSeries(engineInput, {
        start: chartStart,
        end: chartEnd,
        now: NOW,
    });
    check("engine returns one series per configured medication", result.series.length === 1);
    const series = result.series[0];
    check(
        "engine carries logged/scheduled/projected counts",
        series.doseCounts.logged === 1 &&
        series.doseCounts.scheduled === 2 &&
        series.doseCounts.projected === 1,
        JSON.stringify(series.doseCounts)
    );
    check(
        "engine dedupes the pinned log (C = 1 + 0.125, not 2 + 0.125)",
        (() => {
            const value = pointAt(series, d(2026, 1, 15, 8).getTime());
            return value !== null && near(value, 1.125, 1e-12);
        })(),
        String(pointAt(series, d(2026, 1, 15, 8).getTime()))
    );
    check(
        "engine applies future projections to the curve",
        (() => {
            const value = pointAt(series, d(2026, 1, 16, 9).getTime());
            return value !== null && value > 0.2;
        })(),
        String(pointAt(series, d(2026, 1, 16, 9).getTime()))
    );

    const noPast = buildPkConcentrationSeries(engineInput, {
        start: chartStart,
        end: chartEnd,
        now: NOW,
        includePastScheduledDoses: false,
    });
    check(
        "engine option excludes past scheduled doses",
        near(pointAt(noPast.series[0], d(2026, 1, 15, 8).getTime()) ?? -1, 1)
    );

    const noFuture = buildPkConcentrationSeries(engineInput, {
        start: chartStart,
        end: chartEnd,
        now: NOW,
        includeFutureScheduledDoses: false,
    });
    check(
        "engine option excludes future scheduled doses",
        noFuture.series[0].doseCounts.projected === 0
    );

    // Profile precedence: medication half-life beats a default; override beats both.
    const precedence = buildPkConcentrationSeries(
        {medications: [med], schedules: [], doseLogs: []},
        {
            start: chartStart,
            end: chartEnd,
            defaultProfile: {halfLifeHours: 100, eliminationRatePerHour: 0.001},
        }
    );
    check(
        "medication half-life clears a default elimination rate",
        near(precedence.series[0].profile.halfLifeHours, 8),
        String(precedence.series[0].profile.halfLifeHours)
    );
    const overridden = buildPkConcentrationSeries(
        {medications: [med], schedules: [], doseLogs: []},
        {
            start: chartStart,
            end: chartEnd,
            profiles: {[med.id]: {halfLifeHours: 2, bioavailability: 0.5}},
        }
    );
    check(
        "per-medication overrides win",
        near(overridden.series[0].profile.halfLifeHours, 2) &&
        near(overridden.series[0].profile.bioavailability, 0.5)
    );
    const noHalfLife = buildPkConcentrationSeries(
        {medications: [medication("m3", undefined)], schedules: [], doseLogs: []},
        {start: chartStart, end: chartEnd}
    );
    check(
        "missing elimination data skips the series with a warning",
        noHalfLife.series.length === 0 &&
        noHalfLife.warnings.some((warning) => warning.code === "missing-elimination-data")
    );

    // Unconvertible mL log warns but leaves the engine usable.
    const volumeMed = medication("m4", 4, {unit: "mL"});
    const volumeResult = buildPkConcentrationSeries(
        {
            medications: [volumeMed],
            schedules: [],
            doseLogs: [doseLog("l3", volumeMed.id, 0.5, "mL", NOW)],
        },
        {start: chartStart, end: chartEnd}
    );
    check(
        "unconvertible mL log is skipped with a warning",
        volumeResult.series[0].doseCounts.logged === 0 &&
        volumeResult.warnings.some((warning) => warning.code === "unconvertible-dose")
    );
    check(
        "IU doses surface the 1:1 fallback warning",
        buildPkConcentrationSeries(
            {
                medications: [medication("m5", 4, {unit: "IU"})],
                schedules: [],
                doseLogs: [doseLog("l4", "m5", 10, "IU", NOW)],
            },
            {start: chartStart, end: chartEnd}
        ).warnings.some((warning) => warning.code === "iu-fallback")
    );

    // ============================================================== wash-out
    const pruneMed = medication("m6", 1);
    const oldLog = doseLog("old", pruneMed.id, 1, "mg", d(2026, 1, 11));
    const pruned = buildPkConcentrationSeries(
        {medications: [pruneMed], schedules: [], doseLogs: [oldLog]},
        {
            start: d(2026, 1, 15).getTime(),
            end: d(2026, 1, 15, 12).getTime(),
        }
    );
    check(
        "doses beyond the wash-out lookback are pruned to zero",
        pruned.series[0].points[0].concentration === 0
    );

    const recentLog = doseLog("recent", pruneMed.id, 1, "mg", d(2026, 1, 14, 14));
    const residual = buildPkConcentrationSeries(
        {medications: [pruneMed], schedules: [], doseLogs: [recentLog]},
        {
            start: d(2026, 1, 15).getTime(),
            end: d(2026, 1, 15, 12).getTime(),
        }
    );
    check(
        "a dose inside the lookback still seeds the starting residual",
        near(residual.series[0].points[0].concentration, 2 ** -10, 1e-9),
        String(residual.series[0].points[0].concentration)
    );

    // ============================================================= sampling
    const sampleMed = medication("m7", 4);
    const sampleStart = d(2026, 1, 15).getTime();
    const sampleEnd = sampleStart + 12 * H;
    check(
        "date-only window strings are interpreted as local midnight",
        buildPkConcentrationSeries(
            {medications: [], schedules: [], doseLogs: []},
            {start: "2026-01-15", end: "2026-01-16"}
        ).start === sampleStart
    );
    const atOneThirtySeven = sampleStart + 97 * 60_000;
    const samplingLogs = [doseLog("l5", sampleMed.id, 1, "mg", atOneThirtySeven)];
    const withDoseTimes = buildPkConcentrationSeries(
        {medications: [sampleMed], schedules: [], doseLogs: samplingLogs},
        {
            start: sampleStart,
            end: sampleEnd,
            stepMinutes: 120,
            includeDoseTimestamps: true,
        }
    );
    check(
        "dose instants are folded into the sample grid",
        withDoseTimes.series[0].points.some((point) => point.timestamp === atOneThirtySeven)
    );
    const withoutDoseTimes = buildPkConcentrationSeries(
        {medications: [sampleMed], schedules: [], doseLogs: samplingLogs},
        {
            start: sampleStart,
            end: sampleEnd,
            stepMinutes: 120,
            includeDoseTimestamps: false,
        }
    );
    check(
        "includeDoseTimestamps=false keeps a strictly uniform grid",
        !withoutDoseTimes.series[0].points.some((point) => point.timestamp === atOneThirtySeven)
    );
    check(
        "maxPoints caps the uniform grid",
        (() => {
            const capped = buildPkConcentrationSeries(
                {medications: [sampleMed], schedules: [], doseLogs: []},
                {
                    start: sampleStart,
                    end: sampleStart + 24 * H,
                    stepMinutes: 1,
                    maxPoints: 100,
                }
            );
            return capped.series[0].points.length <= 100 &&
                capped.series[0].points.length >= 2;
        })()
    );
    const coarse = buildPkConcentrationSeries(
        {
            medications: [sampleMed], schedules: [], doseLogs: [
                doseLog("l6", sampleMed.id, 1, "mg", sampleStart),
                doseLog("l7", sampleMed.id, 1, "mg", sampleStart + H),
            ]
        },
        {
            start: sampleStart,
            end: sampleStart + 3 * H,
            stepMinutes: 120,
            includeDoseTimestamps: false,
        }
    );
    check(
        "peak is computed exactly even on a coarse chart grid",
        near(coarse.series[0].peak.concentration, 1 + 2 ** -0.25) &&
        coarse.series[0].peak.timestamp === sampleStart + H
    );

    // ==================================================== chunked expansion
    const longSchedule = schedule("s3", "m8", {
        startDate: "2024-01-01",
        doseAmount: 1,
        unit: "mg",
    });
    const chunks = expandSchedulesChunked(
        [longSchedule],
        d(2024, 1, 1).getTime(),
        d(2026, 1, 1).getTime()
    );
    check(
        "chunked occurrence expansion spans ranges beyond MAX_EXPANSION_DAYS",
        chunks.length === 732 && chunks[0].dateIso === "2024-01-01" &&
        chunks[chunks.length - 1].dateIso === "2026-01-01",
        `got ${chunks.length}`
    );

    // ==================================================== large dataset timing
    const bigMed = medication("big", 6);
    const bigLogs: DoseLog[] = [];
    const bigStart = d(2026, 1, 1).getTime();
    for (let index = 0; index < 10_000; index += 1) {
        bigLogs.push(
            doseLog(
                `big-${index}`,
                bigMed.id,
                (index % 5) + 1,
                "mg",
                bigStart + index * 8 * 60_000
            )
        );
    }
    const started = performance.now();
    const bigResult = buildPkConcentrationSeries(
        {medications: [bigMed], schedules: [], doseLogs: bigLogs},
        {
            start: bigStart + 55 * 24 * H,
            end: bigStart + 58 * 24 * H,
            stepMinutes: 30,
            maxPoints: 5000,
        }
    );
    const elapsed = performance.now() - started;
    check(
        "10k-log / 58-day model builds without exploding",
        bigResult.series.length === 1 &&
        bigResult.series[0].points.length > 100 &&
        Number.isFinite(bigResult.series[0].peak.concentration)
    );
    check(
        `large dataset build stays client-friendly (${elapsed.toFixed(1)} ms)`,
        elapsed < 2000
    );

    // ---------------------------------------------------------------- summary
    if (failed) {
        console.error("\nPK smoke test FAILED");
        process.exit(1);
    }
    console.log("\nPK smoke test passed");
}

main();

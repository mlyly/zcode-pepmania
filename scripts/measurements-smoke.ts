/**
 * Smoke test for the body-measurements module, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/measurements-smoke.ts
 *
 * Exercises: the v5 additive migration (live `up` + import `upSnapshot`),
 * idempotent built-in seeding (weight + blood pressure, protected ids),
 * custom tracker CRUD with duplicate-name rejection and kind locking, the
 * BP numeric/string value shapes (service-level kind agreement), log
 * create/update/delete round-trips, range filtering, summary stats, trend
 * row building, and the form-schema validations (BP pair agreement, numeric
 * bounds, datetime conversion).
 */
import "fake-indexeddb/auto";

import {
    canonicalChecksum,
    db,
    ensureDatabase,
    EXPORT_APP_ID,
    EXPORT_FORMAT_VERSION,
    LATEST_SCHEMA_VERSION,
    type MeasurementLog,
    type MeasurementType,
    validateExportPayload,
} from "../lib/db";
import {
    BUILTIN_BLOOD_PRESSURE_ID,
    BUILTIN_MEASUREMENT_TYPES,
    BUILTIN_WEIGHT_ID,
    isBuiltinMeasurementType,
} from "../lib/measurements/constants";
import {
    buildTrendRows,
    effectiveKind,
    filterLogsForRange,
    formatDelta,
    formatMeasurementValue,
    formatStoredValue,
    parseMeasurementValue,
    summarizeLogs,
    toStoredValue,
} from "../lib/measurements/derived";
import {
    measurementLogFormSchema,
    measurementLogToFormValues,
    measurementTypeFormSchema,
    toMeasurementLogInput,
    toMeasurementTypeInput,
} from "../lib/measurements/schema";
import {
    createMeasurementType,
    deleteMeasurementLog,
    deleteMeasurementType,
    getMeasurementLog,
    listMeasurementLogs,
    listMeasurementTypes,
    logMeasurement,
    updateMeasurementLog,
    updateMeasurementType,
} from "../lib/measurements/service";

let failed = false;

function check(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`✓ ${label}`);
    } else {
        console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
        failed = true;
    }
}

async function expectError(label: string, fn: () => Promise<unknown> | unknown) {
    try {
        await fn();
        console.error(`✗ ${label}: expected an error but none thrown`);
        failed = true;
    } catch (error) {
        console.log(`✓ ${label}: ${error instanceof Error ? error.message : error}`);
    }
}

/** Build a LOCAL calendar instant (y/m/d 1-based, h/m 24h). */
function d(year: number, month: number, day: number, hour = 0, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** Fixed reference "now": Thursday 15 Jan 2026, 10:30 local. */
const NOW = d(2026, 1, 15, 10, 30);
const NOW_ISO = NOW.toISOString();

async function main() {
    // ============================================================ v7 pipeline
    const result = await ensureDatabase();
    check(
        "fresh database lands at v7",
        LATEST_SCHEMA_VERSION === 7 && result.to === 7,
        `to=${result.to}`
    );

    // ------------------------------------------------------------- derivation
    check(
        "absent valueKind reads as numeric (pre-v5 rows stay valid)",
        effectiveKind({valueKind: undefined}) === "numeric" &&
        effectiveKind({valueKind: "blood_pressure"}) === "blood_pressure"
    );
    check(
        "BP string parses to a systolic/diastolic pair",
        JSON.stringify(parseMeasurementValue("120/80", "blood_pressure")) ===
        JSON.stringify({kind: "blood_pressure", value: {systolic: 120, diastolic: 80}})
    );
    check(
        "reversed BP pair (dia ≥ sys) is rejected",
        parseMeasurementValue("80/120", "blood_pressure") === null
    );
    check(
        "numeric value on BP kind is rejected",
        parseMeasurementValue(120, "blood_pressure") === null
    );
    check(
        "non-positive / NaN numerics are rejected",
        parseMeasurementValue(0, "numeric") === null &&
        parseMeasurementValue(-3, "numeric") === null &&
        parseMeasurementValue("abc", "numeric") === null
    );
    check(
        "formatMeasurementValue renders units and BP pairs",
        formatMeasurementValue({kind: "numeric", value: 72.5}, "kg") === "72.5 kg" &&
        formatMeasurementValue(
            {kind: "blood_pressure", value: {systolic: 120, diastolic: 80}},
            "mmHg"
        ) === "120/80 mmHg"
    );
    check(
        "formatStoredValue falls back to raw text for unparseable rows",
        formatStoredValue("not-a-number", "numeric", "kg") === "not-a-number"
    );
    check("formatDelta signs deltas for display", formatDelta(1.5) === "+1.5" && formatDelta(-2) === "−2" && formatDelta(0) === "0");
    check(
        "toStoredValue picks the right shape per kind",
        toStoredValue("numeric", 72.5, null) === 72.5 &&
        toStoredValue("blood_pressure", null, {systolic: 118, diastolic: 76}) === "118/76"
    );

    // ------------------------------------------------------------ chart rows
    const chartLogs: MeasurementLog[] = [
        {id: "c3", measurementTypeId: "x", value: 73, timestamp: d(2026, 1, 14).toISOString()},
        {id: "c1", measurementTypeId: "x", value: 72, timestamp: d(2026, 1, 12).toISOString()},
        {id: "c2", measurementTypeId: "x", value: "junk", timestamp: d(2026, 1, 13).toISOString()},
    ];
    const rows = buildTrendRows(chartLogs, "numeric");
    check(
        "trend rows are chronological and skip unparseable values",
        rows.length === 2 && rows[0].value === 72 && rows[1].value === 73
    );
    const bpRows = buildTrendRows(
        [
            {id: "b1", measurementTypeId: "x", value: "120/80", timestamp: d(2026, 1, 10).toISOString()},
            {id: "b2", measurementTypeId: "x", value: "118/78", timestamp: d(2026, 1, 12).toISOString()},
        ],
        "blood_pressure"
    );
    check(
        "BP trend rows carry both components",
        bpRows.length === 2 &&
        bpRows[0].systolic === 120 &&
        bpRows[0].diastolic === 80 &&
        bpRows[1].systolic === 118
    );

    // --------------------------------------------------------------- summaries
    const summary = summarizeLogs(
        [
            {id: "s2", measurementTypeId: "x", value: 72, timestamp: NOW_ISO},
            {id: "s1", measurementTypeId: "x", value: 70, timestamp: d(2026, 1, 10).toISOString()},
        ],
        "numeric"
    );
    check(
        "numeric summary: latest, delta, min/avg/max",
        summary.kind === "numeric" &&
        summary.stats !== null &&
        summary.stats.latest === 72 &&
        summary.stats.delta === 2 &&
        summary.stats.min === 70 &&
        summary.stats.max === 72 &&
        summary.stats.avg === 71
    );
    const bpSummary = summarizeLogs(
        [
            {id: "p2", measurementTypeId: "x", value: "118/78", timestamp: NOW_ISO},
            {id: "p1", measurementTypeId: "x", value: "120/80", timestamp: d(2026, 1, 10).toISOString()},
        ],
        "blood_pressure"
    );
    check(
        "BP summary tracks systolic and diastolic separately",
        bpSummary.kind === "blood_pressure" &&
        bpSummary.systolic?.latest === 118 &&
        bpSummary.systolic?.delta === -2 &&
        bpSummary.diastolic?.latest === 78
    );

    // ------------------------------------------------------------ range filter
    const rangeLogs: MeasurementLog[] = [
        {id: "r1", measurementTypeId: "x", value: 1, timestamp: NOW_ISO},
        {id: "r2", measurementTypeId: "x", value: 2, timestamp: d(2025, 6, 1).toISOString()},
        {id: "r3", measurementTypeId: "other", value: 3, timestamp: NOW_ISO},
    ];
    check(
        "1M range keeps only recent rows of the type (newest first)",
        filterLogsForRange(rangeLogs, "x", "1M", NOW.getTime()).map((l) => l.id).join() === "r1"
    );
    check(
        "all range keeps every row of the type",
        filterLogsForRange(rangeLogs, "x", "all", NOW.getTime()).length === 2
    );

    // ---------------------------------------------------------- form schema
    const typeParsed = measurementTypeFormSchema.parse({
        name: "  Waist Circumference  ",
        unit: " cm ",
        valueKind: "numeric",
    });
    check(
        "type form trims name and unit",
        typeParsed.name === "Waist Circumference" && typeParsed.unit === "cm"
    );
    const canonicalType = toMeasurementTypeInput(typeParsed);
    check(
        "type form converts to the canonical service input",
        canonicalType.name === "Waist Circumference" &&
        canonicalType.unit === "cm" &&
        canonicalType.valueKind === "numeric"
    );
    await expectError(
        "type form rejects a missing unit",
        () => {
            const outcome = measurementTypeFormSchema.safeParse({
                name: "Waist",
                unit: "",
                valueKind: "numeric",
            });
            if (!outcome.success) {
                throw new Error(outcome.error.issues.map((i) => i.message).join("; "));
            }
        }
    );

    let numericInputOk = false;
    const numericForm = measurementLogFormSchema.safeParse({
        measurementTypeId: "t1",
        valueKind: "numeric",
        numericValue: "72.4",
        systolic: "",
        diastolic: "",
        timestamp: "2026-01-15T10:30",
        notes: "morning",
    });
    if (numericForm.success) {
        const input = toMeasurementLogInput(numericForm.data);
        numericInputOk =
            input.value === 72.4 && input.notes === "morning" && input.timestamp === NOW_ISO;
    }
    check("numeric form validates and maps to the canonical input", numericInputOk);
    check(
        "BP form fields collapse to a 'sys/dia' string",
        (() => {
            const outcome = measurementLogFormSchema.safeParse({
                measurementTypeId: "t1",
                valueKind: "blood_pressure",
                numericValue: "",
                systolic: "120",
                diastolic: "80",
                timestamp: "2026-01-15T10:30",
                notes: "",
            });
            if (!outcome.success) return false;
            const input = toMeasurementLogInput(outcome.data);
            return input.value === "120/80" && input.notes === undefined;
        })()
    );
    await expectError(
        "BP form rejects diastolic ≥ systolic",
        () => {
            const outcome = measurementLogFormSchema.safeParse({
                measurementTypeId: "t1",
                valueKind: "blood_pressure",
                numericValue: "",
                systolic: "80",
                diastolic: "120",
                timestamp: "2026-01-15T10:30",
                notes: "",
            });
            if (!outcome.success) {
                throw new Error(outcome.error.issues.map((i) => i.message).join("; "));
            }
        }
    );
    await expectError(
        "numeric form rejects a non-positive value",
        () => {
            const outcome = measurementLogFormSchema.safeParse({
                measurementTypeId: "t1",
                valueKind: "numeric",
                numericValue: "0",
                systolic: "",
                diastolic: "",
                timestamp: "2026-01-15T10:30",
                notes: "",
            });
            if (!outcome.success) {
                throw new Error(outcome.error.issues.map((i) => i.message).join("; "));
            }
        }
    );
    check(
        "log form prefills BP fields from a stored '120/80' row",
        (() => {
            const values = measurementLogToFormValues(
                {
                    id: "l1",
                    measurementTypeId: BUILTIN_BLOOD_PRESSURE_ID,
                    value: "120/80",
                    timestamp: NOW_ISO,
                },
                [
                    {
                        id: BUILTIN_BLOOD_PRESSURE_ID,
                        name: "Blood Pressure",
                        unit: "mmHg",
                        isCustom: false,
                        valueKind: "blood_pressure",
                    },
                ]
            );
            return values.systolic === "120" && values.diastolic === "80";
        })()
    );

    // ------------------------------------------------------------- Dexie flow
    const types = await listMeasurementTypes();
    check(
        "built-in trackers seed exactly once (weight + blood pressure)",
        types.length === 2 &&
        types[0].id === BUILTIN_WEIGHT_ID &&
        types[1].id === BUILTIN_BLOOD_PRESSURE_ID &&
        types.every((t) => !t.isCustom)
    );
    await listMeasurementTypes(); // second boot must not duplicate
    check(
        "seeding is idempotent across repeated lists",
        (await db.measurementTypes.count()) === 2
    );
    check(
        "builtin ids are recognized as built-ins",
        isBuiltinMeasurementType(BUILTIN_WEIGHT_ID) &&
        isBuiltinMeasurementType(BUILTIN_BLOOD_PRESSURE_ID) &&
        !isBuiltinMeasurementType("random-id")
    );
    check(
        "builtin seed table matches what was stored",
        BUILTIN_MEASUREMENT_TYPES.every(
            (seed) =>
                types.find((t) => t.id === seed.id)?.name === seed.name &&
                types.find((t) => t.id === seed.id)?.valueKind === seed.valueKind
        )
    );

    const waist = await createMeasurementType({
        name: "Waist Circumference",
        unit: "cm",
        valueKind: "numeric",
    });
    check("custom tracker is created as custom", waist.isCustom === true);
    await expectError(
        "duplicate tracker name is rejected (case-insensitive)",
        () => createMeasurementType({name: "waist circumference", unit: "cm", valueKind: "numeric"})
    );

    const weightLog = await logMeasurement({
        measurementTypeId: BUILTIN_WEIGHT_ID,
        value: 72.4,
        timestamp: d(2026, 1, 10).toISOString(),
    });
    const bpLog = await logMeasurement({
        measurementTypeId: BUILTIN_BLOOD_PRESSURE_ID,
        value: "120/80",
        timestamp: d(2026, 1, 11).toISOString(),
    });
    check("numeric reading stores a number", typeof weightLog.value === "number");
    check("BP reading stores the 'sys/dia' string", bpLog.value === "120/80");
    await expectError(
        "BP tracker refuses a plain number",
        () => logMeasurement({measurementTypeId: BUILTIN_BLOOD_PRESSURE_ID, value: 120})
    );
    await expectError(
        "weight tracker refuses a BP string",
        () => logMeasurement({measurementTypeId: BUILTIN_WEIGHT_ID, value: "120/80"})
    );
    await expectError(
        "out-of-shape BP string is rejected",
        () => logMeasurement({measurementTypeId: BUILTIN_BLOOD_PRESSURE_ID, value: "80/120"})
    );
    await expectError(
        "unknown tracker is rejected",
        () => logMeasurement({measurementTypeId: "nope", value: 1})
    );

    const editedWeight = await updateMeasurementLog(weightLog.id, {
        measurementTypeId: BUILTIN_WEIGHT_ID,
        value: 72.8,
        timestamp: d(2026, 1, 10, 8).toISOString(),
        notes: "re-weighed",
    });
    check(
        "reading update restamps value, time and notes",
        editedWeight.value === 72.8 && editedWeight.notes === "re-weighed"
    );
    const cleared = await updateMeasurementLog(weightLog.id, {
        measurementTypeId: BUILTIN_WEIGHT_ID,
        value: 72.8,
        timestamp: editedWeight.timestamp,
    });
    check("PUT semantics: omitted notes clear the stored value", cleared.notes === undefined);

    const updatedWaist = await updateMeasurementType(waist.id, {
        name: "Waist",
        unit: "cm",
        valueKind: "numeric",
    });
    check("custom tracker renames", updatedWaist.name === "Waist");
    await expectError(
        "custom tracker with readings can't switch kind",
        async () => {
            await logMeasurement({measurementTypeId: waist.id, value: 92, timestamp: NOW_ISO});
            return updateMeasurementType(waist.id, {name: "Waist", unit: "mmHg", valueKind: "blood_pressure"});
        }
    );
    const renamedWeight = await updateMeasurementType(BUILTIN_WEIGHT_ID, {
        name: "Body Weight",
        unit: "lbs",
        valueKind: "numeric",
    });
    check(
        "built-in keeps its identity and kind but takes new name/unit",
        renamedWeight.name === "Body Weight" &&
        renamedWeight.unit === "lbs" &&
        renamedWeight.isCustom === false &&
        renamedWeight.valueKind === "numeric"
    );
    await expectError(
        "built-in trackers can't be deleted",
        () => deleteMeasurementType(BUILTIN_WEIGHT_ID)
    );
    await expectError(
        "custom tracker kind change is refused once readings exist",
        () => updateMeasurementType(waist.id, {name: "Waist", unit: "cm", valueKind: "blood_pressure"})
    );

    const allLogs = await listMeasurementLogs();
    check(
        "logs list newest first",
        allLogs.length === 3 &&
        allLogs[0].timestamp >= allLogs[1].timestamp &&
        allLogs[1].timestamp >= allLogs[2].timestamp
    );

    await deleteMeasurementLog(bpLog.id);
    check("single reading deletes", (await getMeasurementLog(bpLog.id)) === undefined);

    const removed = await deleteMeasurementType(waist.id);
    check(
        "tracker delete cascades its readings",
        removed === 1 &&
        (await db.measurementTypes.get(waist.id)) === undefined &&
        (await db.measurementLogs.where("measurementTypeId").equals(waist.id).count()) === 0
    );

    // ------------------------------------------------------------- v5 snapshot
    const legacyData = {
        schemaVersion: 4,
        medications: [],
        schedules: [],
        doseLogs: [],
        measurementTypes: [
            {id: "legacy", name: "Old Tracker", unit: "x", isCustom: true},
        ],
        measurementLogs: [],
    };
    const promoted = await validateExportPayload(
        JSON.stringify({
            app: EXPORT_APP_ID,
            formatVersion: EXPORT_FORMAT_VERSION,
            exportedAt: NOW_ISO,
            data: legacyData,
            checksum: await canonicalChecksum(legacyData),
        })
    );
    check(
        "v4 export payload promotes cleanly to v5 (absent valueKind ≡ numeric)",
        promoted.data.schemaVersion === LATEST_SCHEMA_VERSION &&
        (promoted.data.measurementTypes[0] as MeasurementType).id === "legacy"
    );

    console.log(failed ? "\n✗ measurements smoke FAILED" : "\n✓ measurements smoke passed");
    if (failed) process.exit(1);
}

main().catch((error) => {
    console.error("✗ measurements smoke crashed:", error);
    process.exit(1);
});

/**
 * Smoke test for the dose log module, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/dose-logs-smoke.ts
 *
 * Exercises: the datetime-local conversions (minute precision, local-zone
 * round-trips, impossible-date rejection), the `prefilledDoseAmount` derived
 * helper, the shared dose form schema (site preset/"other"/"not recorded"
 * resolution, numeric + datetime validation, create/edit round-trip), the v4
 * additive migration (both the live `up` and the import `upSnapshot` twin),
 * import promotion of a v3 export, and the Dexie service (logDose/logDoses/
 * getDoseLog/updateDoseLog with provenance preservation/deleteDoseLog).
 *
 * Everything that is time-sensitive is evaluated against a fixed reference
 * instant so the assertions are deterministic regardless of when the test
 * runs.
 */
import "fake-indexeddb/auto";

import {
    canonicalChecksum,
    db,
    type DoseLog,
    ensureDatabase,
    EXPORT_APP_ID,
    EXPORT_FORMAT_VERSION,
    LATEST_SCHEMA_VERSION,
    type Medication,
    MIGRATIONS,
    runMigrations,
    type Schedule,
    SCHEMA_VERSION_KEY,
    validateExportPayload,
} from "../lib/db";
import {CUSTOM_SITE, MAX_SITE_LENGTH, UNSPECIFIED_SITE} from "../lib/scheduling/constants";
import {DATETIME_LOCAL_PATTERN, datetimeLocalToIso, isoToDatetimeLocal, isSameLocalDay} from "../lib/scheduling/dates";
import {prefilledDoseAmount} from "../lib/scheduling/derived";
import {
    doseLogFormSchema,
    doseLogInputSchema,
    doseLogToFormValues,
    doseLogUpdateInputSchema,
    resolveInjectionSite,
    siteSelectionFor,
    toDoseLogInput,
} from "../lib/scheduling/schema";
import {deleteDoseLog, getDoseLog, listDoseLogs, logDose, logDoses, updateDoseLog,} from "../lib/scheduling/service";

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

/**
 * Fixed reference "now": Thursday 15 Jan 2026, 10:30 local.
 * (1 Jan 2026 is a Thursday, so 15 Jan is too — weekday 4.)
 */
const NOW = d(2026, 1, 15, 10, 30);
const NOW_ISO = NOW.toISOString();

// Fixture data (ids are plain strings — the dose schemas only need shapes).
const medA: Medication = {
    id: "med-a",
    name: "Semaglutide",
    type: "peptide",
    unit: "mg",
    reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 2},
    inventory: {currentQuantity: 10, vialCount: 2, lowStockThreshold: 2},
    halfLifeHours: 168,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
};
const medB: Medication = {
    id: "med-b",
    name: "BPC-157",
    type: "peptide",
    unit: "mcg",
    inventory: {currentQuantity: 500, vialCount: 1},
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
};
const scheduleA: Schedule = {
    id: "sched-a",
    medicationId: "med-a",
    doseAmount: 1,
    unit: "mg",
    frequencyType: "weekly",
    weekdays: [1],
    timeOfDay: "09:00",
    startDate: "2026-01-05",
    active: true,
};

async function main() {
    // ======================================================== datetime-local
    check(
        "isoToDatetimeLocal renders local wall-clock time at minute precision",
        isoToDatetimeLocal(NOW_ISO) === "2026-01-15T10:30",
        isoToDatetimeLocal(NOW_ISO)
    );
    const withSeconds = new Date(NOW.getTime() + 45_000);
    check("isoToDatetimeLocal drops seconds", isoToDatetimeLocal(withSeconds.toISOString()) === "2026-01-15T10:30", isoToDatetimeLocal(withSeconds.toISOString()));
    check("isoToDatetimeLocal returns empty string for unparseable input", isoToDatetimeLocal("garbage") === "");
    check(
        "datetimeLocalToIso interprets the value as LOCAL wall-clock time",
        datetimeLocalToIso("2026-01-15T10:30") === NOW_ISO,
        `${datetimeLocalToIso("2026-01-15T10:30")} vs ${NOW_ISO}`
    );
    check(
        "the round-trip is the identity (iso → local → iso)",
        datetimeLocalToIso(isoToDatetimeLocal(NOW_ISO)) === NOW_ISO
    );
    check("datetimeLocalToIso accepts an optional seconds field", datetimeLocalToIso("2026-01-15T10:30:45") !== null);
    check("datetimeLocalToIso rejects impossible 2026-02-30", datetimeLocalToIso("2026-02-30T10:00") === null);
    check("datetimeLocalToIso rejects a two-digit year", datetimeLocalToIso("26-01-15T10:30") === null);
    check("datetimeLocalToIso rejects a date without a time", datetimeLocalToIso("2026-01-15") === null);
    check("the pattern rejects unpadded fields", !DATETIME_LOCAL_PATTERN.test("2026-1-15T10:30"));

    // ===================================================== prefilledDoseAmount
    check(
        "prefill uses the first active schedule in the medication's own unit",
        prefilledDoseAmount(medA, [scheduleA]) === 1
    );
    check(
        "prefill ignores schedules of other medications",
        prefilledDoseAmount(medB, [scheduleA]) === 1,
        `got ${prefilledDoseAmount(medB, [scheduleA])}`
    );
    check("prefill is 1 for a medication without schedules", prefilledDoseAmount(medA, []) === 1);
    check("prefill is 1 for a missing medication", prefilledDoseAmount(undefined, [scheduleA]) === 1);
    check(
        "prefill skips paused schedules",
        prefilledDoseAmount(medA, [{...scheduleA, active: false}]) === 1
    );
    check(
        "prefill skips schedules in a different unit",
        prefilledDoseAmount(medA, [{...scheduleA, unit: "mcg"}]) === 1
    );

    // ============================================================= form schema
    // -- site field helpers
    const presetSite = siteSelectionFor({injectionSite: "Abdomen"});
    check(
        "siteSelectionFor keeps a preset as its preset",
        presetSite.siteSelection === "Abdomen" && presetSite.siteDetail === ""
    );
    const customSite = siteSelectionFor({injectionSite: "Left outer thigh"});
    check(
        "siteSelectionFor maps free text to 'other' + detail",
        customSite.siteSelection === CUSTOM_SITE && customSite.siteDetail === "Left outer thigh"
    );
    const noSite = siteSelectionFor(null);
    check(
        "siteSelectionFor maps an absent site to 'not recorded'",
        noSite.siteSelection === UNSPECIFIED_SITE && noSite.siteDetail === ""
    );
    check(
        "resolveInjectionSite keeps a preset (ignoring a stale detail)",
        resolveInjectionSite({siteSelection: "Thigh", siteDetail: "stale"}) === "Thigh"
    );
    check(
        "resolveInjectionSite trims the 'other' detail",
        resolveInjectionSite({siteSelection: CUSTOM_SITE, siteDetail: "  Left thigh  "}) === "Left thigh"
    );
    check(
        "resolveInjectionSite drops an empty 'other' detail",
        resolveInjectionSite({siteSelection: CUSTOM_SITE, siteDetail: "   "}) === undefined
    );
    check(
        "resolveInjectionSite drops 'not recorded' entirely",
        resolveInjectionSite({siteSelection: UNSPECIFIED_SITE, siteDetail: "ignored"}) === undefined
    );

    // -- create mode: dialog defaults seed from the first medication
    const defaults = doseLogToFormValues(null, [medA, medB], [scheduleA]);
    check("create mode seeds the first medication", defaults.medicationId === "med-a");
    check(
        "create mode prefills the schedule dose in the medication's unit",
        defaults.doseAmount === "1" && defaults.unit === "mg",
        `got ${defaults.doseAmount} ${defaults.unit}`
    );
    check(
        "create mode stamps the current instant (pattern-checked, not pinned)",
        DATETIME_LOCAL_PATTERN.test(defaults.timestamp) &&
        datetimeLocalToIso(defaults.timestamp) !== null,
        defaults.timestamp
    );
    check(
        "create mode leaves the site unrecorded and notes empty",
        defaults.siteSelection === UNSPECIFIED_SITE && defaults.siteDetail === "" && defaults.notes === ""
    );

    // -- validated values → canonical service input (create)
    const parsedForm = doseLogFormSchema.parse({
        medicationId: "med-a",
        doseAmount: "1.5",
        unit: "mg",
        timestamp: "2026-01-15T10:30",
        siteSelection: "Abdomen",
        siteDetail: "",
        notes: "  test  ",
    });
    const createdInput = toDoseLogInput(parsedForm);
    check(
        "toDoseLogInput numbers the dose and stamps the instant",
        createdInput.doseAmount === 1.5 &&
        createdInput.unit === "mg" &&
        createdInput.timestamp === NOW_ISO,
        JSON.stringify(createdInput)
    );
    check(
        "toDoseLogInput resolves the site and trims the notes",
        createdInput.injectionSite === "Abdomen" && createdInput.notes === "test"
    );
    check(
        "the form output passes the canonical create schema",
        doseLogInputSchema.safeParse(createdInput).success
    );
    check(
        "the form output passes the canonical edit schema (timestamp present)",
        doseLogUpdateInputSchema.safeParse(createdInput).success
    );

    // -- edit mode: stored log → form → canonical (full round-trip)
    const savedLog: DoseLog = {
        id: "round-1",
        medicationId: "med-a",
        doseAmount: 2.5,
        unit: "mg",
        timestamp: NOW_ISO,
        scheduleId: "sched-a",
        scheduledFor: NOW_ISO,
        injectionSite: "Left outer thigh",
        notes: "tolerated well",
    };
    const editValues = doseLogToFormValues(savedLog, [medA, medB], [scheduleA]);
    check(
        "edit mode prefills amount, unit and time",
        editValues.doseAmount === "2.5" &&
        editValues.unit === "mg" &&
        editValues.timestamp === "2026-01-15T10:30",
        JSON.stringify({dose: editValues.doseAmount, unit: editValues.unit, ts: editValues.timestamp})
    );
    check(
        "edit mode maps the stored free-text site to 'other' + detail",
        editValues.siteSelection === CUSTOM_SITE && editValues.siteDetail === "Left outer thigh"
    );
    const roundTrip = toDoseLogInput(doseLogFormSchema.parse(editValues));
    check(
        "the form round-trip preserves every stored field",
        roundTrip.medicationId === "med-a" &&
        roundTrip.doseAmount === 2.5 &&
        roundTrip.unit === "mg" &&
        roundTrip.timestamp === NOW_ISO &&
        roundTrip.injectionSite === "Left outer thigh" &&
        roundTrip.notes === "tolerated well",
        JSON.stringify(roundTrip)
    );

    // -- validation failures
    const zeroDose = doseLogFormSchema.safeParse({...defaults, doseAmount: "0"});
    check(
        "form rejects a zero dose",
        !zeroDose.success && zeroDose.error.issues.some((i) => i.path[0] === "doseAmount"),
        zeroDose.success ? "parsed unexpectedly" : JSON.stringify(zeroDose.error.issues)
    );
    const notANumber = doseLogFormSchema.safeParse({...defaults, doseAmount: "abc"});
    check(
        "form rejects a non-numeric dose",
        !notANumber.success && notANumber.error.issues.some((i) => i.path[0] === "doseAmount")
    );
    const tooLarge = doseLogFormSchema.safeParse({...defaults, doseAmount: "1e99"});
    check(
        "form rejects an unreasonable dose size",
        !tooLarge.success && tooLarge.error.issues.some((i) => i.path[0] === "doseAmount")
    );
    const emptyDose = doseLogFormSchema.safeParse({...defaults, doseAmount: "   "});
    check(
        "form rejects a blank dose",
        !emptyDose.success && emptyDose.error.issues.some((i) => i.path[0] === "doseAmount")
    );
    const impossibleDate = doseLogFormSchema.safeParse({...defaults, timestamp: "2026-02-30T10:00"});
    check(
        "form rejects an impossible calendar date",
        !impossibleDate.success && impossibleDate.error.issues.some((i) => i.path[0] === "timestamp")
    );
    const malformedDatetime = doseLogFormSchema.safeParse({...defaults, timestamp: "2026-1-15T10:30"});
    check(
        "form rejects a malformed datetime-local value",
        !malformedDatetime.success && malformedDatetime.error.issues.some((i) => i.path[0] === "timestamp")
    );
    const emptyOther = doseLogFormSchema.safeParse({
        ...defaults,
        siteSelection: CUSTOM_SITE,
        siteDetail: "  ",
    });
    check(
        "form requires a description when the site is 'other'",
        !emptyOther.success && emptyOther.error.issues.some((i) => i.path[0] === "siteDetail")
    );
    const longSite = doseLogFormSchema.safeParse({
        ...defaults,
        siteSelection: CUSTOM_SITE,
        siteDetail: "x".repeat(MAX_SITE_LENGTH + 1),
    });
    check(
        "form caps the free-text site at 60 characters",
        !longSite.success && longSite.error.issues.some((i) => i.path[0] === "siteDetail")
    );

    // ============================================================ v3 → v4 migration
    await ensureDatabase();
    check(
        "fresh database stamps the current schema v4",
        LATEST_SCHEMA_VERSION === 4 && (await ensureDatabase()).to === 4
    );

    // Simulate a v3-era database: meta says 3, with a pre-v4 dose log
    // (no `injectionSite`).
    await Promise.all([db.schedules.clear(), db.doseLogs.clear()]);
    await db.meta.put({key: SCHEMA_VERSION_KEY, value: 3});
    await db.doseLogs.bulkPut([
        {
            id: "v3-log",
            medicationId: "med-a",
            doseAmount: 1,
            unit: "mg",
            timestamp: NOW_ISO,
            scheduledFor: NOW_ISO,
        } satisfies DoseLog,
    ]);

    const migrated = await runMigrations();
    check(
        "runMigrations reports v3 → v4 (applies only v4)",
        migrated.from === 3 && migrated.to === 4 && migrated.applied.join() === "4",
        `got ${migrated.from} → ${migrated.to} (${migrated.applied.join()})`
    );
    const survived = (await db.doseLogs.get("v3-log"))!;
    check(
        "v4 is additive: existing rows pass through untouched",
        survived.injectionSite === undefined &&
        survived.doseAmount === 1 &&
        survived.scheduledFor === NOW_ISO,
        JSON.stringify(survived)
    );

    // The import-path twin (pure snapshot mutation).
    const snapshot = {
        schemaVersion: 3,
        medications: [],
        schedules: [],
        doseLogs: [
            {
                id: "snap-1",
                medicationId: "med-a",
                doseAmount: 1,
                unit: "mg",
                timestamp: NOW_ISO,
            },
        ],
        measurementTypes: [],
        measurementLogs: [],
    } as never;
    const snapshotBefore = JSON.stringify(snapshot);
    MIGRATIONS.find((m) => m.version === 4)!.upSnapshot!(snapshot as never);
    check("v4's upSnapshot is a no-op on import payloads", JSON.stringify(snapshot) === snapshotBefore);

    // A v3 export round-trips through the import validator, promoted to v4.
    const v3Data = {
        schemaVersion: 3,
        medications: [medA],
        schedules: [scheduleA],
        doseLogs: [
            {
                id: "exp-1",
                medicationId: "med-a",
                doseAmount: 1,
                unit: "mg",
                timestamp: NOW_ISO,
                scheduledFor: NOW_ISO,
            },
        ],
        measurementTypes: [],
        measurementLogs: [],
    };
    const payload = {
        app: EXPORT_APP_ID,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: NOW_ISO,
        data: v3Data,
        checksum: await canonicalChecksum(v3Data),
    };
    const validated = await validateExportPayload(JSON.stringify(payload));
    check(
        "importing a v3 export promotes it to the current schema",
        validated.data.schemaVersion === LATEST_SCHEMA_VERSION,
        `got ${validated.data.schemaVersion}`
    );
    check(
        "the promoted export keeps its dose logs as-is",
        (validated.data.doseLogs as { id: string }[]).length === 1
    );

    // ============================================================ service: logDose
    const abdomen = await logDose({
        medicationId: "med-a",
        doseAmount: 1,
        unit: "mg",
        timestamp: NOW_ISO,
        injectionSite: "  Abdomen  ",
        notes: "   front of belly   ",
    });
    check("logDose trims the stored injection site", abdomen.injectionSite === "Abdomen", String(abdomen.injectionSite));
    check("logDose trims the stored notes", abdomen.notes === "front of belly", String(abdomen.notes));

    const blankSite = await logDose({
        medicationId: "med-a",
        doseAmount: 2,
        unit: "mg",
        timestamp: NOW_ISO,
        injectionSite: "   ",
    });
    check("logDose maps a whitespace-only site to undefined", blankSite.injectionSite === undefined, String(blankSite.injectionSite));

    const defaulted = await logDose({medicationId: "med-a", doseAmount: 1, unit: "mg"});
    check(
        "logDose defaults the timestamp to now",
        Math.abs(Date.parse(defaulted.timestamp) - Date.now()) < 60_000,
        defaulted.timestamp
    );

    await expectError("logDose rejects a zero dose", () => logDose({medicationId: "med-a", doseAmount: 0, unit: "mg"}));
    await expectError("logDose rejects a negative dose", () => logDose({
        medicationId: "med-a",
        doseAmount: -1,
        unit: "mg"
    }));
    await expectError("logDose rejects a unit outside DoseUnit", () => logDose({
        medicationId: "med-a",
        doseAmount: 1,
        unit: "g" as never
    }));
    await expectError(
        `logDose rejects a site over ${MAX_SITE_LENGTH} characters`,
        () => logDose({
            medicationId: "med-a",
            doseAmount: 1,
            unit: "mg",
            injectionSite: "x".repeat(MAX_SITE_LENGTH + 1)
        })
    );

    // ================================================ service: logDoses (batch)
    const batch = await logDoses(
        [
            {medicationId: "med-a", doseAmount: 1, unit: "mg"},
            {medicationId: "med-b", doseAmount: 250, unit: "mcg"},
        ],
        d(2026, 1, 16, 9, 0).toISOString()
    );
    check("logDoses creates one log per input", batch.length === 2);
    check(
        "logDoses shares the supplied batch timestamp",
        batch.every((log) => log.timestamp === d(2026, 1, 16, 9, 0).toISOString())
    );

    // ===================================================== service: getDoseLog
    check("getDoseLog returns the stored record", (await getDoseLog(abdomen.id))?.doseAmount === 1);
    check("getDoseLog returns undefined for a missing id", (await getDoseLog("nope")) === undefined);

    // ================================================== service: updateDoseLog
    const schedLog = await logDose({
        medicationId: "med-a",
        scheduleId: "sched-a",
        scheduledFor: d(2026, 1, 18, 9, 0).toISOString(),
        doseAmount: 0.5,
        unit: "mg",
        timestamp: d(2026, 1, 18, 9, 5).toISOString(),
        injectionSite: "Thigh",
        notes: "checked off from the checklist",
    });
    check(
        "logDose keeps the schedule provenance fields",
        schedLog.scheduleId === "sched-a" && schedLog.scheduledFor === d(2026, 1, 18, 9, 0).toISOString()
    );

    const updated = await updateDoseLog(schedLog.id, {
        medicationId: "med-a",
        doseAmount: 1,
        unit: "mg",
        timestamp: d(2026, 1, 19, 9, 0).toISOString(),
        injectionSite: "Thigh",
    });
    check(
        "updateDoseLog PUTs the editable fields",
        updated.doseAmount === 1 &&
        updated.unit === "mg" &&
        updated.timestamp === d(2026, 1, 19, 9, 0).toISOString() &&
        updated.injectionSite === "Thigh"
    );
    check(
        "updateDoseLog preserves scheduleId + scheduledFor provenance",
        updated.scheduleId === "sched-a" && updated.scheduledFor === d(2026, 1, 18, 9, 0).toISOString()
    );
    check(
        "updateDoseLog keeps the record id stable and persists",
        updated.id === schedLog.id && (await getDoseLog(schedLog.id))?.doseAmount === 1
    );

    const cleared = await updateDoseLog(schedLog.id, {
        medicationId: "med-b",
        doseAmount: 250,
        unit: "mcg",
        timestamp: d(2026, 1, 19, 9, 0).toISOString(),
    });
    check(
        "updateDoseLog clears unset optional fields (site, notes)",
        cleared.injectionSite === undefined && cleared.notes === undefined && cleared.medicationId === "med-b"
    );
    check("provenance survives the clearing update too", (await getDoseLog(schedLog.id))?.scheduleId === "sched-a");

    await expectError(
        "updateDoseLog rejects an unknown log id",
        () => updateDoseLog("nope", {medicationId: "med-a", doseAmount: 1, unit: "mg", timestamp: NOW_ISO})
    );
    await expectError(
        "updateDoseLog rejects an invalid timestamp",
        () => updateDoseLog(schedLog.id, {medicationId: "med-a", doseAmount: 1, unit: "mg", timestamp: "not-a-date"})
    );
    await expectError(
        `updateDoseLog rejects a site over ${MAX_SITE_LENGTH} characters`,
        () =>
            updateDoseLog(schedLog.id, {
                medicationId: "med-a",
                doseAmount: 1,
                unit: "mg",
                timestamp: NOW_ISO,
                injectionSite: "x".repeat(MAX_SITE_LENGTH + 1),
            })
    );
    await expectError(
        "updateDoseLog requires a unit",
        () => updateDoseLog(schedLog.id, {medicationId: "med-a", doseAmount: 1, timestamp: NOW_ISO} as never)
    );

    // =================================================== service: listDoseLogs
    await logDose({medicationId: "med-b", doseAmount: 250, unit: "mcg", timestamp: d(2026, 1, 12, 8, 0).toISOString()});
    await logDose({medicationId: "med-b", doseAmount: 250, unit: "mcg", timestamp: d(2026, 1, 13, 8, 0).toISOString()});
    const listed = await listDoseLogs();
    const listedTs = listed.map((log) => log.timestamp);
    check(
        "listDoseLogs returns every record, newest first",
        listedTs.every((t, i) => i === 0 || listedTs[i - 1] >= t) &&
        listedTs.includes(d(2026, 1, 12, 8, 0).toISOString()) &&
        listedTs.includes(d(2026, 1, 13, 8, 0).toISOString()),
        listedTs.join(" | ")
    );

    // =================================================== service: deleteDoseLog
    const doomed = await logDose({
        medicationId: "med-b",
        doseAmount: 250,
        unit: "mcg",
        timestamp: d(2026, 1, 13, 9, 0).toISOString()
    });
    await deleteDoseLog(doomed.id);
    check("deleteDoseLog removes the record", (await getDoseLog(doomed.id)) === undefined);
    await deleteDoseLog(doomed.id); // a second delete is a no-op
    check("deleting a missing record is a no-op", (await getDoseLog(doomed.id)) === undefined);

    // ================================================================ day grouping
    const morning = d(2026, 1, 15, 6, 30);
    const evening = d(2026, 1, 15, 23, 59);
    const afterMidnight = d(2026, 1, 16, 0, 0);
    check("isSameLocalDay groups a whole local day together", isSameLocalDay(morning, evening));
    check("isSameLocalDay splits on a local-midnight boundary", !isSameLocalDay(evening, afterMidnight));

    // ==================================================================== summary
    if (failed) {
        console.error("\nDose-log smoke test FAILED");
        process.exit(1);
    }
    console.log("\nDose-log smoke test passed");
    process.exit(0);
}

main().catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
});

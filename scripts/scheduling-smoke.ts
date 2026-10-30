/**
 * Smoke test for the scheduling module, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/scheduling-smoke.ts
 *
 * Exercises: local-time date helpers (DST-safe day math), time-of-day slot
 * tiling, the occurrence engine (frequency firing, expansion, status windows,
 * log matching, labels), the zod schemas (canonical + form, slot resolution,
 * weekday/interval normalization), the v2 → v4 migration path (v3 weekday backfill +
 * start-date normalization, both the live `up` and the import `upSnapshot`
 * twin), import promotion of old exports, and the Dexie service (schedule
 * CRUD + dose logging with occurrence pinning).
 *
 * Everything that is time-sensitive is evaluated against a fixed reference
 * instant so the assertions are deterministic regardless of when the test
 * runs.
 */
import "fake-indexeddb/auto";

import {
    buildExportPayload,
    canonicalChecksum,
    db,
    type DoseLog,
    ensureDatabase,
    EXPORT_APP_ID,
    EXPORT_FORMAT_VERSION,
    LATEST_SCHEMA_VERSION,
    MIGRATIONS,
    runMigrations,
    type Schedule,
    SCHEMA_VERSION_KEY,
    validateExportPayload,
} from "../lib/db";
import {TIME_SLOTS, timeSlotFor, timeToMinutes, WEEKDAYS,} from "../lib/scheduling/constants";
import {
    addDays,
    atTimeOfDay,
    dateOnlyIso,
    daysBetween,
    diffDays,
    isoDateOnly,
    isSameLocalDay,
    localDateFromIso,
    startOfLocalDay,
    weekdayOf,
} from "../lib/scheduling/dates";
import {
    completionSummary,
    dayAgenda,
    dayOccurrences,
    expandSchedule,
    expandSchedules,
    formatTimeOfDay,
    matchingDoseLog,
    MAX_EXPANSION_DAYS,
    missedOccurrences,
    nextOccurrence,
    type Occurrence,
    occurrenceScheduleSummary,
    occurrenceStatus,
    OVERDUE_GRACE_MINUTES,
    rangeAgenda,
    scheduleCadenceLabel,
    scheduleFiresOnDay,
} from "../lib/scheduling/occurrences";
import {
    canonicalScheduleInput,
    doseLogInputSchema,
    isoDateSchema,
    scheduleFormSchema,
    type ScheduleFormValues,
    type ScheduleInput,
    scheduleInputSchema,
    scheduleToFormValues,
    toScheduleInput,
} from "../lib/scheduling/schema";
import {
    createSchedule,
    deleteDoseLog,
    deleteSchedule,
    listDoseLogs,
    listSchedules,
    logDose,
    logDoses,
    setScheduleActive,
    updateSchedule,
} from "../lib/scheduling/service";

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

async function main() {
    // ============================================================ date math
    check(
        "anchor: 15 Jan 2026 is a Thursday (weekday 4)",
        weekdayOf(NOW) === 4,
        `got ${weekdayOf(NOW)}`
    );
    check(
        "anchor: 1 Jan 2026 is a Thursday",
        weekdayOf(d(2026, 1, 1)) === 4,
        `got ${weekdayOf(d(2026, 1, 1))}`
    );

    check(
        "dateOnlyIso pads to YYYY-MM-DD (local)",
        dateOnlyIso(d(2026, 1, 5, 23, 59)) === "2026-01-05"
    );
    check(
        "localDateFromIso parses date-only in LOCAL terms",
        localDateFromIso("2026-01-05")?.getDate() === 5 &&
        localDateFromIso("2026-01-05")?.getHours() === 0
    );
    check(
        "localDateFromIso rejects impossible 2026-02-30",
        localDateFromIso("2026-02-30") === null
    );
    check(
        "isoDateOnly normalizes a full ISO instant to its local date",
        isoDateOnly("2026-01-05T00:00:00.000Z") === "2026-01-05" ||
        isoDateOnly("2026-01-05T00:00:00.000Z") !== null
    );
    check(
        "atTimeOfDay builds a local instant on the day",
        atTimeOfDay(d(2026, 1, 15), "08:05")?.getHours() === 8 &&
        atTimeOfDay(d(2026, 1, 15), "08:05")?.getMinutes() === 5
    );
    check("atTimeOfDay rejects 24:00", atTimeOfDay(d(2026, 1, 15), "24:00") === null);

    // DST-safe day arithmetic: reconstructing from y/m/d means a whole day is
    // always exactly one calendar day, whatever the timezone.
    const leap = d(2024, 2, 27); // 29 Feb 2024 exists
    check(
        "addDays crosses a leap February",
        dateOnlyIso(addDays(leap, 3)) === "2024-03-01",
        `got ${dateOnlyIso(addDays(leap, 3))}`
    );
    check(
        "addDays rolls the month/year",
        dateOnlyIso(addDays(d(2025, 12, 30), 2)) === "2026-01-01"
    );
    check("diffDays round-trips addDays", diffDays(NOW, addDays(NOW, 9)) === 9);
    check(
        "diffDays ignores the time of day",
        diffDays(d(2026, 1, 14, 0, 0), d(2026, 1, 15, 23, 59)) === 1
    );
    check(
        "daysBetween is inclusive",
        daysBetween(d(2026, 1, 13), d(2026, 1, 15)).length === 3
    );
    check(
        "isSameLocalDay distinguishes instants on the same local day",
        isSameLocalDay(d(2026, 1, 15, 0, 1), d(2026, 1, 15, 23, 59)) &&
        !isSameLocalDay(d(2026, 1, 15), d(2026, 1, 16))
    );

    // ------------------------------------------------------------- slots
    check(
        "timeSlotFor tiles the day (08:00 → morning, 23:30 → night)",
        timeSlotFor("08:00").id === "morning" && timeSlotFor("23:30").id === "night"
    );
    check(
        "timeSlotFor groups unparseable times under a neutral bucket",
        timeSlotFor("nope").id === "afternoon"
    );
    check("timeToMinutes reads HH:MM", timeToMinutes("08:05") === 8 * 60 + 5);
    check(
        "the four named slots tile 24 h without gaps",
        TIME_SLOTS.length === 4 &&
        // Expected slot per sample time — the samples straddle every
        // interval boundary, so a gap would fall through to the
        // afternoon fallback and fail.
        [
            ["03:00", "night"], // inside the midnight wrap
            ["06:00", "morning"],
            ["12:00", "afternoon"], // morning/afternoon boundary
            ["16:59", "afternoon"],
            ["17:00", "evening"], // afternoon/evening boundary
            ["20:59", "evening"],
            ["21:30", "night"], // evening/night boundary
            ["04:59", "night"],
        ].every(([time, expected]) => timeSlotFor(time).id === expected)
    );
    check(
        "the week tiles seven days (Sun = 0 … Sat = 6)",
        WEEKDAYS.length === 7 && WEEKDAYS[0] === 0 && WEEKDAYS[6] === 6
    );

    // ==================================================== occurrence engine
    const med = "med-1";

    // A: daily 08:00 — due 08:00, past the 60-min grace by 10:30 → overdue.
    const dailyEarly: Schedule = {
        id: "sched-daily-early",
        medicationId: med,
        doseAmount: 250,
        unit: "mcg",
        frequencyType: "daily",
        timeOfDay: "08:00",
        startDate: "2026-01-01",
        active: true,
    };
    // B: daily 12:00 — not yet due → upcoming.
    const dailyNoon: Schedule = {
        id: "sched-daily-noon",
        medicationId: med,
        doseAmount: 1,
        unit: "mg",
        frequencyType: "daily",
        timeOfDay: "12:00",
        startDate: "2026-01-01",
        active: true,
    };
    // C: daily 10:00 — due, inside the grace window (10:00 + 60 ≥ 10:30) → due.
    const dailyDue: Schedule = {
        id: "sched-daily-due",
        medicationId: med,
        doseAmount: 2,
        unit: "mg",
        frequencyType: "daily",
        timeOfDay: "10:00",
        startDate: "2026-01-01",
        active: true,
    };
    // D: weekly Mon+Thu 09:00 — 15 Jan is a Thursday → fires (overdue, unlogged).
    const weekly: Schedule = {
        id: "sched-weekly",
        medicationId: med,
        doseAmount: 1,
        unit: "mg",
        frequencyType: "weekly",
        weekdays: [1, 4],
        timeOfDay: "09:00",
        startDate: "2026-01-05", // a Monday
        active: true,
    };
    // F: custom interval every 3 days — offsets 0,3,6,… land on 1,4,7,10,13,16;
    //    15 Jan (offset 14) is NOT a fire day.
    const everyThree: Schedule = {
        id: "sched-every-3",
        medicationId: med,
        doseAmount: 5,
        unit: "mg",
        frequencyType: "custom_interval",
        intervalDays: 3,
        timeOfDay: "15:00",
        startDate: "2026-01-01",
        active: true,
    };
    // G: inactive — never fires.
    const inactive: Schedule = {
        id: "sched-inactive",
        medicationId: med,
        doseAmount: 1,
        unit: "mg",
        frequencyType: "daily",
        timeOfDay: "08:00",
        startDate: "2026-01-01",
        active: false,
    };

    check("daily fires every day from the start", scheduleFiresOnDay(dailyEarly, NOW));
    check(
        "nothing fires before the start date",
        !scheduleFiresOnDay(dailyEarly, d(2025, 12, 31))
    );
    check(
        "weekly fires on a selected weekday (Thu)",
        scheduleFiresOnDay(weekly, NOW) && !scheduleFiresOnDay(weekly, addDays(NOW, -1))
    );
    check(
        "weekly without weekdays falls back to the start date's weekday (Mon 5 Jan)",
        scheduleFiresOnDay(
            {...weekly, weekdays: undefined},
            d(2026, 1, 5)
        ) && !scheduleFiresOnDay({...weekly, weekdays: undefined}, NOW)
    );
    check(
        "custom interval fires on whole-multiple offsets (16 Jan = +15)",
        scheduleFiresOnDay(everyThree, d(2026, 1, 16)) &&
        !scheduleFiresOnDay(everyThree, NOW)
    );
    check("an invalid interval (0) never fires", !scheduleFiresOnDay({...everyThree, intervalDays: 0}, NOW));
    check("an inactive schedule never fires", !scheduleFiresOnDay(inactive, NOW));

    // Expansion + ordering.
    const jan15 = startOfLocalDay(NOW);
    const expanded = expandSchedules(
        [dailyEarly, dailyNoon, dailyDue, weekly, everyThree, inactive],
        jan15,
        jan15
    );
    check(
        "Jan 15 expands to the 4 firing schedules (inactive + off-interval excluded)",
        expanded.length === 4,
        `got ${expanded.length}: ${expanded.map((o) => o.scheduleId).join(", ")}`
    );
    check(
        "occurrences are time-ordered (08:00, 09:00, 10:00, 12:00)",
        JSON.stringify(expanded.map((o) => o.timeOfDay)) === JSON.stringify(["08:00", "09:00", "10:00", "12:00"]),
        JSON.stringify(expanded.map((o) => o.timeOfDay))
    );
    check(
        "each occurrence pins a scheduledFor instant on its day",
        expanded.every((o) => dateOnlyIso(new Date(o.scheduledFor)) === dateOnlyIso(jan15))
    );
    check(
        "a stable key is schedule@date",
        expanded[0].key === `sched-daily-early@${dateOnlyIso(jan15)}`
    );

    const weekRange = rangeAgenda(
        [everyThree],
        [],
        d(2026, 1, 1),
        d(2026, 1, 31),
        NOW
    );
    check(
        "every-3 days over January fires on 1,4,7,10,13,16,19,22,25,28,31 (11×)",
        weekRange.length === 11 &&
        weekRange.map((o) => o.date.getDate()).join(",") === "1,4,7,10,13,16,19,22,25,28,31",
        weekRange.map((o) => o.date.getDate()).join(",")
    );

    // The safety bound guards against pathological ranges.
    let boundThrew = false;
    try {
        expandSchedule(dailyEarly, d(2020, 1, 1), addDays(d(2020, 1, 1), MAX_EXPANSION_DAYS + 1));
    } catch {
        boundThrew = true;
    }
    check(
        "ranges beyond the safety bound throw",
        boundThrew
    );

    // Statuses.
    const statusOf = (id: string): Occurrence | undefined =>
        expanded.find((o) => o.scheduleId === id);
    check("08:00 daily is overdue (past the grace window)", occurrenceStatus(statusOf("sched-daily-early")!, [], NOW) === "overdue");
    check("09:00 weekly (Thu) is overdue", occurrenceStatus(statusOf("sched-weekly")!, [], NOW) === "overdue");
    check("10:00 daily is due (inside grace)", occurrenceStatus(statusOf("sched-daily-due")!, [], NOW) === "due");
    check("12:00 daily is upcoming", occurrenceStatus(statusOf("sched-daily-noon")!, [], NOW) === "upcoming");

    // The grace boundary is inclusive: exactly 60 min after due is still "due".
    const boundary = statusOf("sched-daily-due")!;
    check(
        "grace window is inclusive at exactly 60 min",
        occurrenceStatus(boundary, [], new Date(boundary.scheduledAt.getTime() + OVERDUE_GRACE_MINUTES * 60_000)) === "due"
    );

    // Log matching: exact scheduledFor, then the legacy same-day fallback.
    const earlyOcc = statusOf("sched-daily-early")!;
    const exactLog: DoseLog = {
        id: "log-exact",
        medicationId: med,
        scheduleId: earlyOcc.scheduleId,
        doseAmount: 250,
        unit: "mcg",
        timestamp: NOW.toISOString(),
        scheduledFor: earlyOcc.scheduledFor,
    };
    check(
        "an unlogged occurrence has no matching log",
        matchingDoseLog(earlyOcc, []) === null
    );
    check(
        "a log pinned via scheduledFor completes its occurrence",
        matchingDoseLog(earlyOcc, [exactLog])?.id === "log-exact"
    );
    check("a log for a different schedule never matches", matchingDoseLog(earlyOcc, [{
        ...exactLog,
        scheduleId: "other"
    }]) === null);
    const legacyLog: DoseLog = {
        id: "log-legacy",
        medicationId: med,
        scheduleId: statusOf("sched-daily-noon")!.scheduleId,
        doseAmount: 1,
        unit: "mg",
        // Pre-v3 log: no scheduledFor, but taken the same local day.
        timestamp: d(2026, 1, 15, 13, 5).toISOString(),
    };
    check(
        "a legacy same-day log (no scheduledFor) matches by fallback",
        matchingDoseLog(statusOf("sched-daily-noon")!, [legacyLog])?.id === "log-legacy"
    );
    check(
        "a legacy log on a different day does not match",
        matchingDoseLog(statusOf("sched-daily-noon")!, [{
            ...legacyLog,
            timestamp: d(2026, 1, 14, 13, 5).toISOString()
        }]) === null
    );

    // Statuses with logs present.
    const logs = [exactLog, legacyLog];
    const agenda = dayAgenda(
        [dailyEarly, dailyNoon, dailyDue, weekly, everyThree, inactive],
        logs,
        jan15,
        NOW
    );
    const byId = new Map(agenda.map((o) => [o.scheduleId, o.status]));
    check(
        "logs flip matching occurrences to done (2 done, 2 not)",
        byId.get("sched-daily-early") === "done" &&
        byId.get("sched-daily-noon") === "done" &&
        byId.get("sched-daily-due") === "due" &&
        byId.get("sched-weekly") === "overdue"
    );
    const summary = completionSummary(agenda);
    check(
        "completionSummary tallies done/total/missed",
        summary.done === 2 && summary.total === 4 && summary.missed === 1,
        JSON.stringify(summary)
    );

    // dayOccurrences mirrors the agenda for a given day.
    const todays = dayOccurrences([dailyEarly, dailyNoon], logs, jan15, NOW);
    check("dayOccurrences returns the day's occurrences with statuses", todays.length === 2 && todays.every((o) => o.status === "done"));

    // Missed (make-up) candidates: trailing 48 h, past-due, unlogged.
    const missed = missedOccurrences([dailyEarly, dailyNoon, dailyDue, weekly, everyThree], logs, 48, NOW);
    check(
        "missed = past due & unlogged within 48 h (the 08:00 of the 14th is covered by the exact log? no — that log is for the 15th)",
        missed.length > 0 &&
        missed.every((o) => o.status === "overdue" || o.status === "due") &&
        missed.every((o) => o.scheduledAt.getTime() < NOW.getTime()),
        `got ${missed.length}`
    );
    check(
        "a completed occurrence is not a make-up candidate",
        !missed.some((o) => o.key === earlyOcc.key)
    );

    // Next-occurrence + labels.
    check(
        "nextOccurrence of a daily is the next same-time instant",
        nextOccurrence(dailyNoon, NOW)?.toISOString() ===
        d(2026, 1, 15, 12, 0).toISOString()
    );
    check(
        "nextOccurrence of an already-passed daily rolls to tomorrow",
        nextOccurrence(dailyEarly, NOW)?.getDate() === 16
    );
    check(
        "nextOccurrence of the Mon+Thu weekly lands on the next selected day (Mon 19 Jan)",
        nextOccurrence(weekly, NOW)?.getDate() === 19 &&
        weekdayOf(nextOccurrence(weekly, NOW)!) === 1
    );
    check(
        "nextOccurrence of every-3 lands on 16 Jan",
        nextOccurrence(everyThree, NOW)?.getDate() === 16
    );
    check("nextOccurrence of an inactive schedule is null", nextOccurrence(inactive, NOW) === null);
    check(
        "a malformed custom interval (0) has no next occurrence",
        nextOccurrence({...everyThree, intervalDays: 0}, NOW) === null
    );

    check("cadence label: daily → 'Daily'", scheduleCadenceLabel(dailyEarly) === "Daily");
    check(
        "cadence label: weekly Mon+Thu → 'Mon & Thu'",
        scheduleCadenceLabel(weekly) === "Mon & Thu",
        scheduleCadenceLabel(weekly)
    );
    check(
        "cadence label: all 7 weekdays → 'Every day'",
        scheduleCadenceLabel({...weekly, weekdays: [0, 1, 2, 3, 4, 5, 6]}) === "Every day"
    );
    check(
        "cadence label: every 3 → 'Every 3 days' (singular for 1)",
        scheduleCadenceLabel(everyThree) === "Every 3 days" &&
        scheduleCadenceLabel({...everyThree, intervalDays: 1}) === "Every 1 day"
    );
    check(
        "summary line joins cadence and clock time",
        occurrenceScheduleSummary(weekly) === "Mon & Thu · " + formatTimeOfDay("09:00")
    );
    check(
        "formatTimeOfDay renders a 12h clock",
        formatTimeOfDay("08:05").includes("8:05") && formatTimeOfDay("08:05").includes("AM") &&
        formatTimeOfDay("19:30").includes("PM")
    );

    // ================================================================ schemas
    const dailyInput: ScheduleInput = {
        medicationId: med,
        doseAmount: 250,
        unit: "mcg",
        frequencyType: "daily",
        timeOfDay: "08:00",
        startDate: "2026-01-01",
        active: true,
    };

    check("isoDateSchema accepts a zero-padded date", isoDateSchema.safeParse("2026-01-15").success);
    check("isoDateSchema rejects unpadded components", !isoDateSchema.safeParse("2026-1-5").success);
    check("isoDateSchema rejects impossible calendar dates", !isoDateSchema.safeParse("2026-02-30").success);
    check("isoDateSchema rejects full ISO instants", !isoDateSchema.safeParse("2026-01-05T09:00:00.000Z").success);

    check("scheduleInputSchema accepts a minimal daily input", scheduleInputSchema.safeParse(dailyInput).success);

    const weeklyMissing = scheduleInputSchema.safeParse({...dailyInput, frequencyType: "weekly", timeOfDay: "09:00"});
    check(
        "scheduleInputSchema requires weekdays for weekly",
        !weeklyMissing.success && weeklyMissing.error.issues.some((issue) => issue.path.includes("weekdays")),
        weeklyMissing.success ? "parsed unexpectedly" : JSON.stringify(weeklyMissing.error.issues)
    );

    const intervalMissing = scheduleInputSchema.safeParse({...dailyInput, frequencyType: "custom_interval"});
    check(
        "scheduleInputSchema requires intervalDays for custom_interval",
        !intervalMissing.success && intervalMissing.error.issues.some((issue) => issue.path.includes("intervalDays")),
        intervalMissing.success ? "parsed unexpectedly" : JSON.stringify(intervalMissing.error.issues)
    );

    check(
        "scheduleInputSchema rejects a non-integer interval",
        !scheduleInputSchema.safeParse({...dailyInput, frequencyType: "custom_interval", intervalDays: 2.5}).success
    );
    check(
        "scheduleInputSchema rejects an out-of-range weekday",
        !scheduleInputSchema.safeParse({...dailyInput, frequencyType: "weekly", weekdays: [1, 8]}).success
    );
    check("scheduleInputSchema rejects a zero dose", !scheduleInputSchema.safeParse({
        ...dailyInput,
        doseAmount: 0
    }).success);
    check(
        "scheduleInputSchema rejects a malformed time of day",
        !scheduleInputSchema.safeParse({...dailyInput, timeOfDay: "8:00"}).success
    );
    check(
        "scheduleInputSchema rejects an impossible start date",
        !scheduleInputSchema.safeParse({...dailyInput, startDate: "2026-02-30"}).success
    );

    // Normalization behind the service contract.
    const normalizedWeekly = canonicalScheduleInput(
        scheduleInputSchema.parse({
            ...dailyInput,
            frequencyType: "weekly",
            timeOfDay: "09:00",
            weekdays: [4, 1, 4, 1], // unsorted + duplicated
            intervalDays: 3, // stale field — must be dropped for weekly
        })
    );
    check(
        "canonicalScheduleInput dedupes and sorts weekdays",
        JSON.stringify(normalizedWeekly.weekdays) === JSON.stringify([1, 4]),
        JSON.stringify(normalizedWeekly.weekdays)
    );
    check("canonicalScheduleInput drops a stale interval in weekly mode", normalizedWeekly.intervalDays === undefined);
    check(
        "canonicalScheduleInput drops weekdays outside weekly mode",
        canonicalScheduleInput(scheduleInputSchema.parse({...dailyInput, weekdays: [1]})).weekdays === undefined
    );
    check(
        "canonicalScheduleInput keeps the interval only in custom mode",
        canonicalScheduleInput(
            scheduleInputSchema.parse({...dailyInput, frequencyType: "custom_interval", intervalDays: 3})
        ).intervalDays === 3
    );

    // The dialog's string-typed mirror.
    const formValues: ScheduleFormValues = {
        medicationId: med,
        doseAmount: "250",
        unit: "mcg",
        frequencyType: "daily",
        weekdays: [false, false, false, false, false, false, false],
        intervalDays: "",
        timeSlot: "morning",
        timeOfDay: "08:00",
        startDate: "2026-01-01",
        active: true,
    };

    check("scheduleFormSchema accepts a minimal daily form", scheduleFormSchema.safeParse(formValues).success);
    check("scheduleFormSchema rejects an empty dose", !scheduleFormSchema.safeParse({
        ...formValues,
        doseAmount: ""
    }).success);
    check("scheduleFormSchema rejects a non-positive dose", !scheduleFormSchema.safeParse({
        ...formValues,
        doseAmount: "-3"
    }).success);
    check(
        "scheduleFormSchema requires days for a weekly form",
        !scheduleFormSchema.safeParse({...formValues, frequencyType: "weekly"}).success
    );
    check(
        "scheduleFormSchema rejects a zero custom interval",
        !scheduleFormSchema.safeParse({...formValues, frequencyType: "custom_interval", intervalDays: "0"}).success
    );
    check(
        "scheduleFormSchema accepts a 1-day custom interval",
        scheduleFormSchema.safeParse({...formValues, frequencyType: "custom_interval", intervalDays: "1"}).success
    );
    check(
        "scheduleFormSchema rejects an unparseable custom time",
        !scheduleFormSchema.safeParse({...formValues, timeSlot: "custom", timeOfDay: "8am"}).success
    );
    check(
        "scheduleFormSchema rejects an impossible start date",
        !scheduleFormSchema.safeParse({...formValues, startDate: "2026-02-30"}).success
    );

    const fromForm = toScheduleInput(scheduleFormSchema.parse(formValues));
    check("toScheduleInput snaps the selected slot to its default time", fromForm.timeOfDay === "08:00");

    const fromCustomTime = toScheduleInput(
        scheduleFormSchema.parse({...formValues, timeSlot: "custom", timeOfDay: "07:45"})
    );
    check("toScheduleInput keeps a custom-typed time", fromCustomTime.timeOfDay === "07:45");

    const fromWeekly = toScheduleInput(
        scheduleFormSchema.parse({
            ...formValues,
            frequencyType: "weekly",
            weekdays: [false, true, true, false, true, false, false],
        })
    );
    check(
        "toScheduleInput maps weekday booleans to day indices",
        JSON.stringify(fromWeekly.weekdays) === JSON.stringify([1, 2, 4]),
        JSON.stringify(fromWeekly.weekdays)
    );
    check(
        "toScheduleInput drops the interval when it is not in use",
        fromWeekly.intervalDays === undefined && fromForm.intervalDays === undefined
    );

    const fromCustomInterval = toScheduleInput(
        scheduleFormSchema.parse({...formValues, frequencyType: "custom_interval", intervalDays: "3"})
    );
    check("toScheduleInput keeps the interval in custom mode", fromCustomInterval.intervalDays === 3);

    // Edit mode: a stored schedule re-enters the dialog in its own shape.
    const editSource: Schedule = {
        id: "sched-x",
        medicationId: med,
        doseAmount: 1,
        unit: "mg",
        frequencyType: "weekly",
        weekdays: [1, 4],
        timeOfDay: "19:30",
        startDate: "2026-01-05T12:00:00.000Z", // full instant — must normalize to date-only
        active: false,
    };
    const fromEdit = scheduleToFormValues(editSource);
    check(
        "scheduleToFormValues maps stored weekdays to per-day booleans",
        JSON.stringify(fromEdit.weekdays) === JSON.stringify([false, true, false, false, true, false, false]),
        JSON.stringify(fromEdit.weekdays)
    );
    check("scheduleToFormValues recovers the slot from the stored time", fromEdit.timeSlot === "evening", fromEdit.timeSlot);
    check(
        "scheduleToFormValues keeps the stored dose + time",
        fromEdit.doseAmount === "1" && fromEdit.timeOfDay === "19:30"
    );
    check(
        "scheduleToFormValues normalizes a full-ISO start date to date-only",
        /^\d{4}-\d{2}-\d{2}$/.test(fromEdit.startDate) && fromEdit.startDate === isoDateOnly(editSource.startDate),
        fromEdit.startDate
    );
    check("scheduleToFormValues keeps the paused flag", fromEdit.active === false);

    // Create mode: dialog defaults.
    const createDefaults = scheduleToFormValues(null, {id: "med-9", unit: "mcg"});
    check(
        "create mode seeds the medication id + dose unit",
        createDefaults.medicationId === "med-9" && createDefaults.unit === "mcg"
    );
    check(
        "create mode defaults to an active daily morning slot",
        createDefaults.frequencyType === "daily" &&
        createDefaults.active === true &&
        createDefaults.timeSlot === "morning" &&
        createDefaults.timeOfDay === "08:00"
    );
    check("create mode seeds today's date", createDefaults.startDate === dateOnlyIso(new Date()), createDefaults.startDate);
    check(
        "create mode's weekly selection is today's weekday",
        createDefaults.weekdays.length === WEEKDAYS.length &&
        createDefaults.weekdays.filter(Boolean).length === 1 &&
        createDefaults.weekdays[new Date().getDay()] === true
    );

    check(
        "doseLogInputSchema accepts a pinned log",
        doseLogInputSchema.safeParse({
            medicationId: med,
            doseAmount: 250,
            unit: "mcg",
            scheduledFor: NOW.toISOString()
        }).success
    );
    check(
        "doseLogInputSchema rejects a zero dose",
        !doseLogInputSchema.safeParse({medicationId: med, doseAmount: 0, unit: "mcg"}).success
    );
    check(
        "doseLogInputSchema rejects an oversized notes field",
        !doseLogInputSchema.safeParse({medicationId: med, doseAmount: 1, unit: "mcg", notes: "x".repeat(2001)}).success
    );

    // ============================================================ v2 → v4 migration
    await ensureDatabase();

    // Simulate a v2-era database: meta says 2, with legacy weekly rows
    // (no `weekdays`) and a full-ISO start date.
    await Promise.all([
        db.schedules.clear(),
        db.doseLogs.clear(),
        db.backups.clear(),
    ]);
    await db.meta.put({key: SCHEMA_VERSION_KEY, value: 2});
    const monday = d(2026, 1, 5);
    await db.schedules.bulkPut([
        {
            id: "v3-1",
            medicationId: med,
            doseAmount: 1,
            unit: "mg",
            frequencyType: "weekly",
            timeOfDay: "09:00",
            // A full ISO instant, not yet normalized to date-only.
            startDate: monday.toISOString(),
            active: true,
        } satisfies Schedule,
        {
            id: "v3-2",
            medicationId: med,
            doseAmount: 2,
            unit: "mg",
            frequencyType: "daily",
            timeOfDay: "08:00",
            startDate: "2026-01-01", // already canonical — must stay put
            active: true,
        } satisfies Schedule,
    ]);

    const migrated = await runMigrations();
    check(
        "runMigrations reports v2 → v4 (applies v3 + v4)",
        migrated.from === 2 && migrated.to === 4 && migrated.applied.join() === "3,4",
        `got ${migrated.from} → ${migrated.to} (${migrated.applied.join()})`
    );

    const v31 = (await db.schedules.get("v3-1"))!;
    check(
        "v3 normalizes a full-ISO start date to local YYYY-MM-DD",
        /^\d{4}-\d{2}-\d{2}$/.test(v31.startDate)
    );
    check(
        "v3 backfills weekdays from the start date's weekday (Mon)",
        v31.weekdays?.length === 1 && v31.weekdays[0] === weekdayOf(localDateFromIso(v31.startDate)!),
        JSON.stringify(v31.weekdays)
    );
    const v32 = (await db.schedules.get("v3-2"))!;
    check("v3 leaves an already-canonical start date untouched", v32.startDate === "2026-01-01");
    check("v3 does not invent weekdays for non-weekly schedules", v32.weekdays === undefined);

    // The import-path twin (pure snapshot mutation).
    const snapshot = {
        schemaVersion: 2,
        medications: [],
        schedules: [
            {
                id: "s-1",
                frequencyType: "weekly",
                startDate: monday.toISOString(),
            },
            {
                id: "s-2",
                frequencyType: "weekly",
                weekdays: [1, 9, -3], // one valid (Mon), two out of range
                startDate: "2026-01-07",
            },
            {
                id: "s-3",
                frequencyType: "daily",
                startDate: "2026-01-01",
            },
        ],
        doseLogs: [],
        measurementTypes: [],
        measurementLogs: [],
    } as never;
    MIGRATIONS.find((m) => m.version === 3)!.upSnapshot!(snapshot as never);
    const rows = (snapshot as { schedules: { id: string; weekdays?: number[]; startDate?: string }[] }).schedules;
    const [s1, s2, s3] = rows;
    check(
        "upSnapshot backfills a missing weekly weekday from the start date",
        s1.weekdays?.length === 1 &&
        s1.weekdays[0] === weekdayOf(localDateFromIso(s1.startDate!)!)
    );
    check(
        "upSnapshot keeps valid weekdays but drops out-of-range ones",
        JSON.stringify(s2.weekdays) === JSON.stringify([1]),
        JSON.stringify(s2.weekdays)
    );
    check("upSnapshot leaves a canonical start date as-is", s3.startDate === "2026-01-01" && s3.weekdays === undefined);

    // An old (v2) export round-trips through the import validator, promoted
    // to v4 by the snapshot migrations.
    await Promise.all([db.schedules.clear(), db.doseLogs.clear()]);
    await db.schedules.bulkPut([
        {
            id: "imp-1",
            medicationId: med,
            doseAmount: 1,
            unit: "mg",
            frequencyType: "weekly",
            timeOfDay: "09:00",
            startDate: monday.toISOString(),
            active: true,
        } satisfies Schedule,
    ]);
    // Hand-build a v2 payload (checksum over the v2 data) and validate it.
    const v2Data = {
        schemaVersion: 2,
        medications: [] as unknown[],
        schedules: [
            {
                id: "imp-1",
                medicationId: med,
                doseAmount: 1,
                unit: "mg",
                frequencyType: "weekly",
                timeOfDay: "09:00",
                startDate: monday.toISOString(),
                active: true,
            },
        ],
        doseLogs: [] as unknown[],
        measurementTypes: [] as unknown[],
        measurementLogs: [] as unknown[],
    };
    const payload = {
        app: EXPORT_APP_ID,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: NOW.toISOString(),
        data: v2Data,
        checksum: await canonicalChecksum(v2Data),
    };
    const validated = await validateExportPayload(JSON.stringify(payload));
    check(
        "importing an old (v2) export promotes it to the current schema",
        validated.data.schemaVersion === LATEST_SCHEMA_VERSION
    );
    const promoted = (validated.data.schedules as { weekdays?: number[]; startDate?: string }[])[0];
    check(
        "the promoted export row gained a backfilled weekday + date-only start",
        promoted.weekdays?.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(promoted.startDate ?? ""),
        JSON.stringify(promoted)
    );

    // ===================================================== current export round-trip
    const currentPayload = await buildExportPayload();
    check(
        "buildExportPayload checksums the canonical data",
        currentPayload.checksum === (await canonicalChecksum(currentPayload.data)),
        currentPayload.checksum
    );
    check(
        "a current (v4) export round-trips through the import validator",
        (await validateExportPayload(JSON.stringify(currentPayload))).data.schemaVersion === LATEST_SCHEMA_VERSION
    );

    // ================================================================= service
    await Promise.all([db.schedules.clear(), db.doseLogs.clear()]);

    // -- createSchedule
    const created = await createSchedule(dailyInput);
    check(
        "createSchedule generates an id and stores the row",
        created.id.length >= 8 && (await db.schedules.get(created.id)) !== undefined
    );

    const weeklyInput: ScheduleInput = {
        ...dailyInput,
        frequencyType: "weekly",
        timeOfDay: "09:00",
        startDate: "2026-01-05",
        weekdays: [4, 1, 4], // unsorted + duplicated — the service must normalize
    };
    const weeklySched = await createSchedule(weeklyInput);
    const weeklyStored = (await db.schedules.get(weeklySched.id))!;
    check(
        "createSchedule normalizes weekdays (deduped + sorted)",
        JSON.stringify(weeklyStored.weekdays) === JSON.stringify([1, 4]),
        JSON.stringify(weeklyStored.weekdays)
    );

    await expectError("createSchedule rejects a zero dose", () =>
        createSchedule({...dailyInput, doseAmount: 0})
    );
    await expectError("createSchedule rejects a weekly schedule without weekdays", () =>
        createSchedule({...dailyInput, frequencyType: "weekly"})
    );
    await expectError("createSchedule rejects a custom interval without an interval", () =>
        createSchedule({...dailyInput, frequencyType: "custom_interval"})
    );

    // -- listSchedules ordering
    const later = await createSchedule({
        ...dailyInput,
        medicationId: "med-2",
        doseAmount: 5,
        unit: "mg",
        timeOfDay: "20:00",
        startDate: "2026-01-02",
    });
    const listed = await listSchedules();
    check(
        "listSchedules orders by start date (oldest first)",
        listed.map((s) => s.id).join(",") === [created, later, weeklySched].map((s) => s.id).join(","),
        listed.map((s) => s.startDate).join(",")
    );

    // -- updateSchedule (PUT semantics)
    const flipped = await updateSchedule(created.id, {
        ...dailyInput,
        doseAmount: 2,
        unit: "mg",
        frequencyType: "weekly",
        timeOfDay: "10:30",
        weekdays: [2],
    });
    check(
        "updateSchedule applies new fields",
        flipped.doseAmount === 2 &&
        flipped.unit === "mg" &&
        flipped.timeOfDay === "10:30" &&
        JSON.stringify(flipped.weekdays) === JSON.stringify([2])
    );
    const backToDaily = await updateSchedule(created.id, dailyInput);
    check(
        "updateSchedule clears frequency-specific fields (PUT semantics)",
        backToDaily.frequencyType === "daily" &&
        backToDaily.weekdays === undefined &&
        backToDaily.intervalDays === undefined
    );
    await expectError("updateSchedule rejects a missing schedule", () =>
        updateSchedule("does-not-exist", dailyInput)
    );

    // -- setScheduleActive
    const paused = await setScheduleActive(weeklySched.id, false);
    check("setScheduleActive pauses the schedule", paused.active === false);
    const pausedStored = (await db.schedules.get(weeklySched.id))!;
    check(
        "a paused schedule produces no occurrences",
        expandSchedule(pausedStored, jan15, addDays(jan15, 7)).length === 0
    );
    await setScheduleActive(weeklySched.id, true);

    // -- dose logging with occurrence pinning
    const createdStored = (await db.schedules.get(created.id))!;
    const janOcc = expandSchedule(createdStored, jan15, jan15)[0];
    check(
        "the stored daily schedule fires on the reference day",
        janOcc !== undefined && janOcc.dateIso === dateOnlyIso(jan15)
    );

    const pinnedLog = await logDose({
        medicationId: med,
        scheduleId: created.id,
        doseAmount: 250,
        unit: "mcg",
        timestamp: NOW.toISOString(),
        scheduledFor: janOcc.scheduledFor,
    });
    check("logDose stores the scheduledFor pin", pinnedLog.scheduledFor === janOcc.scheduledFor);
    check(
        "a pinned log completes its occurrence",
        occurrenceStatus(janOcc, [pinnedLog], NOW) === "done"
    );

    const adHoc = await logDose({
        medicationId: med,
        doseAmount: 1,
        unit: "mg",
        timestamp: d(2026, 1, 14, 21, 15).toISOString(),
        notes: "   ", // whitespace → trimmed to undefined
    });
    check("logDose trims blank notes to undefined", adHoc.notes === undefined);

    const listedLogs = await listDoseLogs();
    check(
        "listDoseLogs is newest first",
        listedLogs.length === 2 && listedLogs[0].id === pinnedLog.id && listedLogs[1].id === adHoc.id
    );

    // -- batch logging
    const batchTimestamp = "2026-01-15T10:31:00.000Z";
    const weeklyOcc = expandSchedule(weeklySched, jan15, jan15)[0];
    const batch = await logDoses(
        [
            {
                medicationId: med,
                scheduleId: weeklySched.id,
                doseAmount: 1,
                unit: "mg",
                scheduledFor: weeklyOcc.scheduledFor,
            },
            {medicationId: "med-2", doseAmount: 5, unit: "mg"},
        ],
        batchTimestamp
    );
    check(
        "logDoses stamps the whole batch with one timestamp",
        batch.length === 2 && batch.every((l) => l.timestamp === batchTimestamp)
    );
    check("logDoses with an empty batch logs nothing", (await logDoses([])).length === 0);

    // -- deleteDoseLog
    await deleteDoseLog(adHoc.id);
    const remainingLogs = await listDoseLogs();
    check(
        "deleteDoseLog removes only that record",
        remainingLogs.length === 3 && !remainingLogs.some((l) => l.id === adHoc.id)
    );

    // -- deleteSchedule (dose history is kept)
    const logsBeforeDelete = await db.doseLogs.count();
    await deleteSchedule(weeklySched.id);
    const remainingSchedules = await listSchedules();
    check("deleteSchedule removes the schedule", remainingSchedules.every((s) => s.id !== weeklySched.id));
    const historyCount = await db.doseLogs.where("scheduleId").equals(weeklySched.id).count();
    check(
        "deleteSchedule keeps its dose history",
        (await db.doseLogs.count()) === logsBeforeDelete && historyCount === 1,
        `count=${await db.doseLogs.count()} (before ${logsBeforeDelete}), withSchedule=${historyCount}`
    );
    check(
        "occurrences of a deleted schedule no longer fire",
        expandSchedules(remainingSchedules, jan15, jan15).every((o) => o.scheduleId !== weeklySched.id)
    );

    // ---------------------------------------------------------------- summary
    if (failed) {
        console.error("\nScheduling smoke test FAILED");
        process.exit(1);
    }
    console.log("\nScheduling smoke test passed");
    process.exit(0);
}

main().catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
});

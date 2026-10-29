/**
 * Scheduling CRUD + dose logging on top of Dexie. Every write is validated
 * with the canonical zod schema (defense in depth behind the form).
 *
 * Dose logs are consumption *records*: logging a dose never mutates
 * inventory (stock stays container-driven via the medications module's
 * stepper). Un-logging simply removes the record.
 *
 * The caller is responsible for having run `ensureDatabase()` first (mirrors
 * `lib/medications/service.ts`).
 */
import {db, type DoseLog, type Schedule} from "@/lib/db";

import {
    canonicalScheduleInput,
    type DoseLogInput,
    doseLogInputSchema,
    type ScheduleInput,
    scheduleInputSchema,
} from "./schema";

function newId(): string {
    return crypto.randomUUID();
}

function nowIso(): string {
    return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** All schedules, newest start date first (stable tie-break on id). */
export async function listSchedules(): Promise<Schedule[]> {
    const schedules = await db.schedules.toArray();
    return schedules.sort(
        (a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)
    );
}

export async function getSchedule(id: string): Promise<Schedule | undefined> {
    return db.schedules.get(id);
}

/** Schedules for one medication, ordered by time of day. */
export async function listSchedulesForMedication(medicationId: string): Promise<Schedule[]> {
    const schedules = await db.schedules.where("medicationId").equals(medicationId).toArray();
    return schedules.sort(
        (a, b) => a.timeOfDay.localeCompare(b.timeOfDay) || a.id.localeCompare(b.id)
    );
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
    const parsed = canonicalScheduleInput(scheduleInputSchema.parse(input));
    const schedule: Schedule = {
        id: newId(),
        medicationId: parsed.medicationId,
        doseAmount: parsed.doseAmount,
        unit: parsed.unit,
        frequencyType: parsed.frequencyType,
        weekdays: parsed.weekdays?.length ? parsed.weekdays : undefined,
        intervalDays: parsed.intervalDays,
        timeOfDay: parsed.timeOfDay,
        startDate: parsed.startDate,
        active: parsed.active,
    };
    await db.schedules.put(schedule);
    return schedule;
}

/**
 * Full-replace (PUT) semantics, mirroring the medications service: optional
 * fields the input leaves unset are cleared, so the dialog can remove a
 * weekday set or an interval.
 */
export async function updateSchedule(id: string, input: ScheduleInput): Promise<Schedule> {
    const parsed = canonicalScheduleInput(scheduleInputSchema.parse(input));
    const existing = await db.schedules.get(id);
    if (!existing) throw new Error("Schedule not found — it may have been deleted.");

    const schedule: Schedule = {
        id,
        medicationId: parsed.medicationId,
        doseAmount: parsed.doseAmount,
        unit: parsed.unit,
        frequencyType: parsed.frequencyType,
        weekdays: parsed.weekdays?.length ? parsed.weekdays : undefined,
        intervalDays: parsed.intervalDays,
        timeOfDay: parsed.timeOfDay,
        startDate: parsed.startDate,
        active: parsed.active,
    };
    await db.schedules.put(schedule);
    return schedule;
}

/** Pauses / resumes a schedule without touching its definition. */
export async function setScheduleActive(id: string, active: boolean): Promise<Schedule> {
    const existing = await db.schedules.get(id);
    if (!existing) throw new Error("Schedule not found — it may have been deleted.");
    const updated: Schedule = {...existing, active};
    await db.schedules.put(updated);
    return updated;
}

/**
 * Deletes a schedule. Dose logs referencing it are KEPT — the dose history
 * is a permanent record (the schedule is only the source of future doses).
 */
export async function deleteSchedule(id: string): Promise<void> {
    await db.schedules.delete(id);
}

// ---------------------------------------------------------------------------
// Dose logs
// ---------------------------------------------------------------------------

/** All dose logs, newest first. */
export async function listDoseLogs(): Promise<DoseLog[]> {
    const logs = await db.doseLogs.toArray();
    return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Logs a dose. When `scheduledFor` is provided (checklist / calendar logging)
 * the log is pinned to that occurrence; `scheduleId` without `scheduledFor`
 * records a logged-from-a-schedule ad-hoc dose.
 */
export async function logDose(input: DoseLogInput): Promise<DoseLog> {
    const parsed = doseLogInputSchema.parse(input);
    const log: DoseLog = {
        id: newId(),
        medicationId: parsed.medicationId,
        scheduleId: parsed.scheduleId,
        doseAmount: parsed.doseAmount,
        unit: parsed.unit,
        timestamp: parsed.timestamp ?? nowIso(),
        scheduledFor: parsed.scheduledFor,
        notes: parsed.notes?.trim() || undefined,
    };
    await db.doseLogs.add(log);
    return log;
}

/** Removes a dose log record (undo). Nothing else is touched. */
export async function deleteDoseLog(id: string): Promise<void> {
    await db.doseLogs.delete(id);
}

/**
 * Logs a whole batch of occurrences in a single transaction (the checklist's
 * "Log all" action). Returns the created logs.
 */
export async function logDoses(
    inputs: DoseLogInput[],
    timestampIso?: string
): Promise<DoseLog[]> {
    if (inputs.length === 0) return [];
    const timestamp = timestampIso ?? nowIso();
    return db.transaction("rw", db.doseLogs, async () => {
        const logs: DoseLog[] = [];
        for (const input of inputs) {
            const parsed = doseLogInputSchema.parse(input);
            const log: DoseLog = {
                id: newId(),
                medicationId: parsed.medicationId,
                scheduleId: parsed.scheduleId,
                doseAmount: parsed.doseAmount,
                unit: parsed.unit,
                timestamp,
                scheduledFor: parsed.scheduledFor,
                notes: parsed.notes?.trim() || undefined,
            };
            await db.doseLogs.add(log);
            logs.push(log);
        }
        return logs;
    });
}

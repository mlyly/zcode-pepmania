/**
 * The occurrence engine: expands schedules into concrete, calendar-day dose
 * occurrences and matches them against dose logs to derive completion status.
 *
 * Pure functions (no DB access) so the UI and smoke tests can reason about
 * scheduling deterministically. All day math is local-time (see `dates.ts`).
 */
import type {DoseLog, Schedule} from "@/lib/db/types";

import {
    addDays,
    atTimeOfDay,
    dateOnlyIso,
    daysBetween,
    diffDays,
    isSameLocalDay,
    localDateFromIso,
    weekdayOf,
} from "./dates";
import {WEEKDAY_LABELS} from "./constants";

/**
 * A concrete instance of a schedule: one dose, on one local calendar day,
 * at the schedule's time of day.
 */
export interface Occurrence {
    /** Stable identity: `${scheduleId}@${YYYY-MM-DD}` — one per schedule per day. */
    key: string;
    scheduleId: string;
    medicationId: string;
    /** The scheduled dose as defined on the schedule. */
    doseAmount: number;
    unit: Schedule["unit"];
    /** Local calendar day (midnight) the dose is due on. */
    date: Date;
    /** Local date-only "YYYY-MM-DD". */
    dateIso: string;
    /** The schedule's time of day, "HH:MM". */
    timeOfDay: string;
    /** Local instant the dose is due at (day + timeOfDay). */
    scheduledAt: Date;
    /** ISO form of `scheduledAt` — the canonical match key against `DoseLog.scheduledFor`. */
    scheduledFor: string;
}

export type OccurrenceStatus = "upcoming" | "due" | "overdue" | "done";

/**
 * Grace window after the due time during which an occurrence is still "due"
 * rather than "overdue" (minutes).
 */
export const OVERDUE_GRACE_MINUTES = 60;

/** Safety bound for range expansion (guards against pathological ranges). */
export const MAX_EXPANSION_DAYS = 400;

/**
 * True when the schedule fires on the given calendar day.
 *
 *  - `daily`: every day from `startDate` onward.
 *  - `weekly`: days whose weekday is in `weekdays` (pre-v3 rows fall back to
 *    the weekday of `startDate`, matching the legacy "once a week" behavior).
 *  - `custom_interval`: every `intervalDays` days, anchored on `startDate`
 *    (i.e. days at whole-multiple offsets from the start).
 */
export function scheduleFiresOnDay(schedule: Schedule, day: Date): boolean {
    const start = localDateFromIso(schedule.startDate);
    if (!start) return false;
    const offset = diffDays(start, day);
    if (offset < 0) return false;

    switch (schedule.frequencyType) {
        case "daily":
            return true;
        case "weekly": {
            const weekdays =
                schedule.weekdays && schedule.weekdays.length > 0
                    ? schedule.weekdays
                    : [weekdayOf(start)];
            return weekdays.includes(weekdayOf(day));
        }
        case "custom_interval": {
            const interval = schedule.intervalDays;
            if (!interval || interval < 1) return false;
            return offset % interval === 0;
        }
    }
}

/**
 * Expands a schedule into occurrences for every day in [from, to] (both
 * inclusive, local calendar days). Only days the schedule fires on produce
 * an occurrence. An inactive schedule yields none.
 */
export function expandSchedule(
    schedule: Schedule,
    from: Date,
    to: Date
): Occurrence[] {
    if (!schedule.active) return [];
    const startDay = localDateFromIso(schedule.startDate);
    if (!startDay) return [];
    const range = daysBetween(from, to);
    if (range.length > MAX_EXPANSION_DAYS) {
        throw new Error(
            `Occurrence range of ${range.length} days exceeds the ${MAX_EXPANSION_DAYS}-day safety bound.`
        );
    }

    const occurrences: Occurrence[] = [];
    for (const day of range) {
        if (!scheduleFiresOnDay(schedule, day)) continue;
        const scheduledAt = atTimeOfDay(day, schedule.timeOfDay);
        if (!scheduledAt) continue;
        occurrences.push({
            key: `${schedule.id}@${dateOnlyIso(day)}`,
            scheduleId: schedule.id,
            medicationId: schedule.medicationId,
            doseAmount: schedule.doseAmount,
            unit: schedule.unit,
            date: day,
            dateIso: dateOnlyIso(day),
            timeOfDay: schedule.timeOfDay,
            scheduledAt,
            scheduledFor: scheduledAt.toISOString(),
        });
    }
    return occurrences;
}

/**
 * Expands every schedule in the list for [from, to] and returns the merged,
 * time-ordered occurrence list (earliest first; ties broken by schedule id
 * for stable rendering).
 */
export function expandSchedules(
    schedules: Schedule[],
    from: Date,
    to: Date,
    now: Date = new Date()
): Occurrence[] {
    const all = schedules.flatMap((schedule) => expandSchedule(schedule, from, to, now));
    return all.sort(
        (a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.key.localeCompare(b.key)
    );
}

/**
 * Finds the dose log that completed the occurrence, if any:
 *  1. Exact: a log created for this occurrence (`scheduledFor` matches).
 *  2. Legacy fallback: a log against the same schedule on the same local
 *     calendar day (pre-v3 logs have no `scheduledFor`).
 * Returns null when the occurrence is uncompleted.
 */
export function matchingDoseLog(
    occurrence: Occurrence,
    doseLogs: readonly DoseLog[]
): DoseLog | null {
    let legacy: DoseLog | null = null;
    for (const log of doseLogs) {
        if (log.scheduleId !== occurrence.scheduleId) continue;
        if (log.scheduledFor === occurrence.scheduledFor) return log;
        if (!log.scheduledFor && legacy === null) {
            const timestamp = new Date(log.timestamp);
            if (
                !Number.isNaN(timestamp.getTime()) &&
                isSameLocalDay(timestamp, occurrence.date)
            ) {
                legacy = log;
            }
        }
    }
    return legacy;
}

/**
 * Status of an occurrence relative to `now`:
 *  - `done`: a matching dose log exists.
 *  - `due`: the due instant is now (or within the grace window).
 *  - `overdue`: past the grace window, unlogged.
 *  - `upcoming`: not yet due.
 */
export function occurrenceStatus(
    occurrence: Occurrence,
    doseLogs: readonly DoseLog[],
    now: Date = new Date()
): OccurrenceStatus {
    if (matchingDoseLog(occurrence, doseLogs) !== null) return "done";
    const graceMs = OVERDUE_GRACE_MINUTES * 60 * 1000;
    if (occurrence.scheduledAt.getTime() + graceMs < now.getTime()) return "overdue";
    return occurrence.scheduledAt.getTime() <= now.getTime() ? "due" : "upcoming";
}

/**
 * Attach statuses to a list of occurrences in one pass over the log set.
 * (Returns new objects; input list is not mutated.)
 */
export function withStatuses(
    occurrences: readonly Occurrence[],
    doseLogs: readonly DoseLog[],
    now: Date = new Date()
): (Occurrence & { status: OccurrenceStatus })[] {
    return occurrences.map((occurrence) => ({
        ...occurrence,
        status: occurrenceStatus(occurrence, doseLogs, now),
    }));
}

/**
 * Occurrences due on a single calendar day (the "agenda" for that day),
 * time-ordered, with statuses.
 */
export function dayAgenda(
    schedules: Schedule[],
    doseLogs: readonly DoseLog[],
    day: Date,
    now: Date = new Date()
): (Occurrence & { status: OccurrenceStatus })[] {
    return withStatuses(expandSchedules(schedules, day, day, now), doseLogs, now);
}

/**
 * Occurrences in [from, to] with statuses — the building block for the
 * calendar's "upcoming N days" preview and range queries.
 */
export function rangeAgenda(
    schedules: Schedule[],
    doseLogs: readonly DoseLog[],
    from: Date,
    to: Date,
    now: Date = new Date()
): (Occurrence & { status: OccurrenceStatus })[] {
    return withStatuses(expandSchedules(schedules, from, to, now), doseLogs, now);
}

/**
 * "Today's doses" (AGENTS.md §5.1 Quick Log): every active schedule's
 * occurrence on the given day (default: today), time-ordered, with statuses.
 */
export function dayOccurrences(
    schedules: Schedule[],
    doseLogs: readonly DoseLog[],
    day?: Date,
    now: Date = new Date()
): (Occurrence & { status: OccurrenceStatus })[] {
    const target = day ?? now;
    return dayAgenda(schedules, doseLogs, target, now);
}

/**
 * Past occurrences in the trailing window (default 48 h) that were never
 * logged — candidates for "make up" logging from the checklist.
 */
export function missedOccurrences(
    schedules: Schedule[],
    doseLogs: readonly DoseLog[],
    windowHours = 48,
    now: Date = new Date()
): (Occurrence & { status: OccurrenceStatus })[] {
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    const startDay = localDateFromIso(dateOnlyIso(windowStart)) ?? windowStart;
    const occurrences = rangeAgenda(schedules, doseLogs, startDay, now, now);
    return occurrences.filter(
        (o) => o.scheduledAt.getTime() < now.getTime() && o.status !== "done"
    );
}

/** Occurrences on a day that have completed, for "x of y" progress lines. */
export function completionSummary(
    occurrences: readonly (Occurrence & { status: OccurrenceStatus })[]
): { done: number; total: number; missed: number } {
    let done = 0;
    let missed = 0;
    for (const occurrence of occurrences) {
        if (occurrence.status === "done") done += 1;
        else if (occurrence.status === "overdue") missed += 1;
    }
    return {done, total: occurrences.length, missed};
}

/**
 * Next occurrence of a schedule at or after `from` (scans up to a year
 * ahead). Returns null for schedules that never fire (e.g. a malformed
 * custom interval) or that are inactive.
 */
export function nextOccurrence(schedule: Schedule, from: Date = new Date()): Date | null {
    if (!schedule.active) return null;
    for (let offset = 0; offset <= 365; offset += 1) {
        const day = addDays(from, offset);
        if (!scheduleFiresOnDay(schedule, day)) continue;
        const at = atTimeOfDay(day, schedule.timeOfDay);
        if (!at) continue;
        if (offset === 0 && at.getTime() < from.getTime()) continue;
        return at;
    }
    return null;
}

/**
 * Human summary of a schedule's cadence alone, e.g. "Daily", "Mon & Fri" or
 * "Every 3 days" (re-used by the medications module's row labels).
 */
export function scheduleCadenceLabel(schedule: Schedule): string {
    switch (schedule.frequencyType) {
        case "daily":
            return "Daily";
        case "weekly":
            return weekdaySummary(schedule);
        case "custom_interval":
            return schedule.intervalDays
                ? `Every ${schedule.intervalDays} ${schedule.intervalDays === 1 ? "day" : "days"}`
                : "Custom";
    }
}

/**
 * Full schedule summary, e.g. "Daily · 8:00 AM", "Mon & Fri · 9:00 PM" or
 * "Every 3 days · 7:30 AM".
 */
export function occurrenceScheduleSummary(schedule: Schedule): string {
    return `${scheduleCadenceLabel(schedule)} · ${formatTimeOfDay(schedule.timeOfDay)}`;
}

function weekdaySummary(schedule: Schedule): string {
    const days =
        schedule.weekdays && schedule.weekdays.length > 0
            ? [...schedule.weekdays].sort((a, b) => a - b)
            : [weekdayOf(localDateFromIso(schedule.startDate) ?? new Date())];
    if (days.length === 7) return "Every day";
    const labels = days.map((day) => WEEKDAY_LABELS[day]);
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;
}

/** "08:00" → "8:00 AM" (locale-aware clock rendering). */
export function formatTimeOfDay(timeOfDay: string): string {
    const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay.trim());
    if (!match) return timeOfDay;
    const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
    return date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
}

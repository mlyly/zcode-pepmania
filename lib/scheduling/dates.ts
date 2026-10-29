/**
 * Local-time calendar helpers for the scheduling module.
 *
 * Every "day" concept (occurrence days, calendar grid, "today") is computed in
 * the user's LOCAL timezone: dates are held as `Date` objects pinned to local
 * midnight and serialized as "YYYY-MM-DD" strings. `Date` objects built from
 * `new Date(year, month, day)` are always local, so DST transitions never
 * shift calendar-day arithmetic.
 */

/** "HH:MM" (24h) time-of-day pattern. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Matches "YYYY-MM-DD" date-only strings. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Midnight (local) of the given date — the canonical "calendar day" value.
 * Two dates compare equal on the same day iff their local-date parts match.
 */
export function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Local calendar date "YYYY-MM-DD" of the given date. */
export function dateOnlyIso(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Parses a stored date into a local `Date`. Date-only strings are split on
 * their hyphens (never `new Date(str)`, which would read them as UTC
 * midnight); full ISO instants use the local `Date` getters. Returns null
 * when the value is not a recognizable date.
 */
export function localDateFromIso(value: string): Date | null {
    const trimmed = value.trim();
    if (DATE_ONLY_PATTERN.test(trimmed)) {
        const [year, month, day] = trimmed.split("-").map(Number);
        if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
            return null;
        }
        const date = new Date(year, month - 1, day);
        // Reject impossible calendar dates (e.g. 2026-02-30 rolls over).
        if (
            date.getFullYear() !== year ||
            date.getMonth() + 1 !== month ||
            date.getDate() !== day
        ) {
            return null;
        }
        return date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalizes any recognizable stored date (date-only or full ISO) to a local
 * "YYYY-MM-DD" string; null when unparseable.
 */
export function isoDateOnly(value: string): string | null {
    const date = localDateFromIso(value);
    return date ? dateOnlyIso(date) : null;
}

/** Local `Date` at the given "HH:MM" on the given calendar day. */
export function atTimeOfDay(day: Date, timeOfDay: string): Date | null {
    const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        hour,
        minute,
        0,
        0
    );
}

/** Adds whole days to a local-midnight date (DST-safe). */
export function addDays(day: Date, days: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/**
 * Whole calendar days from `from` to `to` (positive when `to` is later).
 * Both inputs are reduced to local midnight first, so partial instants
 * don't leak fractional days.
 */
export function diffDays(from: Date, to: Date): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    const a = startOfLocalDay(from).getTime();
    const b = startOfLocalDay(to).getTime();
    return Math.round((b - a) / msPerDay);
}

/** Calendar weekday of a date, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: Date): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
    return startOfLocalDay(date).getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** Calendar dates of every day in [from, to] (inclusive), oldest first. */
export function daysBetween(from: Date, to: Date): Date[] {
    const days: Date[] = [];
    let cursor = startOfLocalDay(from);
    const end = startOfLocalDay(to).getTime();
    while (cursor.getTime() <= end) {
        days.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return days;
}

/**
 * True when two instants fall on the same LOCAL calendar day (used for the
 * legacy same-day log→occurrence match fallback).
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
    const as = startOfLocalDay(a);
    const bs = startOfLocalDay(b);
    return (
        as.getFullYear() === bs.getFullYear() &&
        as.getMonth() === bs.getMonth() &&
        as.getDate() === bs.getDate()
    );
}

// ---------------------------------------------------------------------------
// Display formatting (local, no UTC drift)
// ---------------------------------------------------------------------------

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
});
const monthFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
});
const monthHeaderFormatter = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
});

/** e.g. "Thu, Oct 29" — for agenda lines. */
export function formatDay(date: Date): string {
    return fullDateFormatter.format(startOfLocalDay(date));
}

/** e.g. "Thu, Oct 29, 2026" — for calendar headers. */
export function formatDayWithYear(date: Date): string {
    return monthFormatter.format(startOfLocalDay(date));
}

/** e.g. "October 2026" — month grid header. */
export function formatMonthYear(date: Date): string {
    return monthHeaderFormatter.format(startOfLocalDay(date));
}

/** Local clock time of an instant, e.g. "8:00 AM". */
export function formatClockTime(date: Date): string {
    return timeFormatter.format(date);
}

/** Relative label for an upcoming day: "Today" / "Tomorrow" / "in 5 days" / "Oct 2". */
export function formatRelativeDay(date: Date, now = new Date()): string {
    const difference = diffDays(now, date);
    if (difference === 0) return "Today";
    if (difference === 1) return "Tomorrow";
    if (difference > 1 && difference < 14) return `in ${difference} days`;
    const day = startOfLocalDay(date);
    const base = fullDateFormatter.format(day);
    return day.getFullYear() === now.getFullYear()
        ? base
        : `${base} ${day.getFullYear()}`;
}

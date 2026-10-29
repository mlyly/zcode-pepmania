/**
 * Zod schemas for the scheduling module.
 *
 * `scheduleInputSchema` is the canonical, service-level contract (numbers).
 * `scheduleFormSchema` mirrors the add/edit dialog where numeric and time
 * fields are raw string inputs; numeric rules are enforced in a single
 * `superRefine` pass so messages stay human-readable, and `toScheduleInput`
 * turns validated values into the canonical input (dropping fields that the
 * selected frequency type doesn't use, resolving slot → concrete time).
 */
import {z} from "zod";

import type {Medication, Schedule, Weekday} from "@/lib/db/types";
import {DOSE_UNITS} from "@/lib/medications/constants";
import {WEEKDAYS} from "./constants";
import {DATE_ONLY_PATTERN, dateOnlyIso, isoDateOnly, localDateFromIso, TIME_OF_DAY_PATTERN,} from "./dates";

// ---------------------------------------------------------------------------
// Canonical (service-level) schema
// ---------------------------------------------------------------------------

const weekdaySchema = z.number().int("Days of week must be whole numbers").min(0).max(6);

/**
 * Valid "YYYY-MM-DD" — both shape-checked and calendar-checked (rejects
 * impossible dates like 2026-02-30, which `Date` parsing would silently roll
 * over).
 */
export const isoDateSchema = z
    .string()
    .trim()
    .regex(DATE_ONLY_PATTERN, "Use YYYY-MM-DD")
    .refine((value) => localDateFromIso(value) !== null, "Not a real calendar date");

export const timeOfDaySchema = z
    .string()
    .trim()
    .regex(TIME_OF_DAY_PATTERN, "Use HH:MM (24h)");

export const scheduleInputSchema = z
    .object({
        medicationId: z.string().min(1, "Choose a medication"),
        doseAmount: z
            .number()
            .positive("Dose must be greater than zero")
            .max(1e9, "Dose looks too large"),
        unit: z.enum(DOSE_UNITS),
        frequencyType: z.enum(["daily", "weekly", "custom_interval"]),
        /**
         * Days of week (0 = Sun … 6 = Sat) — only meaningful for "weekly".
         * Type-level optional; required for "weekly" via superRefine.
         */
        weekdays: z.array(weekdaySchema).optional(),
        /** Whole days between doses — only meaningful for "custom_interval". */
        intervalDays: z
            .number()
            .int("Interval must be a whole number of days")
            .min(1, "Interval must be at least 1 day")
            .max(365, "Interval looks too large")
            .optional(),
        timeOfDay: timeOfDaySchema,
        startDate: isoDateSchema,
        active: z.boolean(),
    })
    .superRefine((value, ctx) => {
        if (value.frequencyType === "weekly" && (!value.weekdays || value.weekdays.length === 0)) {
            ctx.addIssue({
                code: "custom",
                path: ["weekdays"],
                message: "Pick at least one day of the week",
            });
        }
        if (
            value.frequencyType === "custom_interval" &&
            (value.intervalDays === undefined || value.intervalDays < 1)
        ) {
            ctx.addIssue({
                code: "custom",
                path: ["intervalDays"],
                message: "Required for a custom interval",
            });
        }
    });

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/**
 * Normalized schedule fields: weekdays narrowed to the `Weekday` union,
 * de-duped and sorted; the interval only retained for "custom_interval".
 */
export type CanonicalScheduleInput = Omit<ScheduleInput, "weekdays"> & {
    /** 0 = Sun … 6 = Sat (validated), deduped and sorted. */
    weekdays?: Weekday[];
    intervalDays?: number;
};

/**
 * Normalizes (and strips) frequency-specific fields before storage:
 * de-duped/sorted weekdays for "weekly", the interval only for
 * "custom_interval".
 */
export function canonicalScheduleInput(input: ScheduleInput): CanonicalScheduleInput {
    const weekdays =
        input.frequencyType === "weekly"
            ? [...new Set(input.weekdays)].sort((a, b) => a - b) as Weekday[]
            : undefined;
    const intervalDays =
        input.frequencyType === "custom_interval" ? input.intervalDays : undefined;
    return {
        medicationId: input.medicationId,
        doseAmount: input.doseAmount,
        unit: input.unit,
        frequencyType: input.frequencyType,
        weekdays,
        intervalDays,
        timeOfDay: input.timeOfDay,
        startDate: input.startDate,
        active: input.active,
    };
}

// ---------------------------------------------------------------------------
// Dose log schema
// ---------------------------------------------------------------------------

export const doseLogInputSchema = z.object({
    medicationId: z.string().min(1, "Choose a medication"),
    scheduleId: z.string().min(1).optional(),
    doseAmount: z
        .number()
        .positive("Dose must be greater than zero")
        .max(1e9, "Dose looks too large"),
    unit: z.enum(DOSE_UNITS),
    /** ISO datetime of the actual administration (defaults to now in the service). */
    timestamp: z.string().min(1).optional(),
    /** ISO datetime of the scheduled occurrence this log completes (checklist logs). */
    scheduledFor: z.string().min(1).optional(),
    notes: z
        .string()
        .trim()
        .max(2000, "Notes are limited to 2000 characters")
        .optional(),
});

export type DoseLogInput = z.infer<typeof doseLogInputSchema>;

// ---------------------------------------------------------------------------
// Form (dialog) schema
// ---------------------------------------------------------------------------

export type FormTimeSlot = "morning" | "afternoon" | "evening" | "night" | "custom";

const FORM_TIME_SLOTS = ["morning", "afternoon", "evening", "night", "custom"] as const;

export const scheduleFormSchema = z
    .object({
        medicationId: z.string().min(1, "Choose a medication"),
        doseAmount: z.string(),
        unit: z.enum(DOSE_UNITS),
        frequencyType: z.enum(["daily", "weekly", "custom_interval"]),
        /** One boolean per weekday (S..S) — chips in the dialog. */
        weekdays: z.array(z.boolean()).length(7, "Pick days of the week"),
        intervalDays: z.string(),
        timeSlot: z.enum(FORM_TIME_SLOTS),
        timeOfDay: z.string(),
        startDate: z.string(),
        active: z.boolean(),
    })
    .superRefine((values, ctx) => {
        const dose = values.doseAmount.trim();
        if (dose === "") {
            ctx.addIssue({code: "custom", path: ["doseAmount"], message: "Dose amount is required"});
        } else {
            const amount = Number(dose);
            if (!Number.isFinite(amount) || amount <= 0) {
                ctx.addIssue({code: "custom", path: ["doseAmount"], message: "Dose must be greater than zero"});
            } else if (amount > 1e9) {
                ctx.addIssue({code: "custom", path: ["doseAmount"], message: "Dose looks too large"});
            }
        }

        if (values.frequencyType === "weekly") {
            const selected = values.weekdays.filter(Boolean).length;
            if (selected === 0) {
                ctx.addIssue({
                    code: "custom",
                    path: ["weekdays"],
                    message: "Pick at least one day of the week",
                });
            }
        }

        if (values.frequencyType === "custom_interval") {
            const raw = values.intervalDays.trim();
            if (raw === "") {
                ctx.addIssue({
                    code: "custom",
                    path: ["intervalDays"],
                    message: "Required for a custom interval",
                });
            } else {
                const interval = Number(raw);
                if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["intervalDays"],
                        message: "Interval must be 1–365 whole days",
                    });
                }
            }
        }

        if (values.timeSlot === "custom") {
            if (!TIME_OF_DAY_PATTERN.test(values.timeOfDay.trim())) {
                ctx.addIssue({code: "custom", path: ["timeOfDay"], message: "Use HH:MM (24h)"});
            }
        }

        const startDate = values.startDate.trim();
        if (!DATE_ONLY_PATTERN.test(startDate)) {
            ctx.addIssue({code: "custom", path: ["startDate"], message: "Use YYYY-MM-DD"});
        } else if (isoDateOnly(startDate) === null) {
            ctx.addIssue({code: "custom", path: ["startDate"], message: "Not a real calendar date"});
        }
    });

export type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

// ---------------------------------------------------------------------------
// Conversions between form values and the canonical input
// ---------------------------------------------------------------------------

const SLOT_DEFAULTS: Record<Exclude<FormTimeSlot, "custom">, string> = {
    morning: "08:00",
    afternoon: "14:00",
    evening: "19:00",
    night: "22:00",
};

/** Which slot a stored time belongs in (custom when nothing matches). */
function slotForTime(timeOfDay: string): FormTimeSlot {
    const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay.trim());
    if (!match) return "custom";
    const minute = Number(match[1]) * 60 + Number(match[2]);
    const bounds: [Exclude<FormTimeSlot, "custom">, number, number][] = [
        ["morning", 5 * 60, 12 * 60],
        ["afternoon", 12 * 60, 17 * 60],
        ["evening", 17 * 60, 21 * 60],
        ["night", 21 * 60, 5 * 60],
    ];
    for (const [id, start, end] of bounds) {
        if (start < end ? minute >= start && minute < end : minute >= start || minute < end) {
            return id;
        }
    }
    return "custom";
}

/**
 * Builds dialog defaults. Pass a schedule to prefill for editing; pass a
 * `medication` (create mode) to seed its id and dose unit.
 */
export function scheduleToFormValues(
    schedule?: Schedule | null,
    medication?: Pick<Medication, "id" | "unit"> | null
): ScheduleFormValues {
    // Local calendar date — never `toISOString().slice(0,10)` (UTC drift).
    const todayIso = dateOnlyIso(new Date());
    if (!schedule) {
        return {
            medicationId: medication?.id ?? "",
            doseAmount: "",
            unit: medication?.unit ?? "mg",
            frequencyType: "daily",
            // Default weekly selection: today's day of the week.
            weekdays: WEEKDAYS.map((_, index) => index === new Date().getDay()),
            intervalDays: "7",
            timeSlot: "morning",
            timeOfDay: "08:00",
            startDate: todayIso,
            active: true,
        };
    }
    const weekdays = WEEKDAYS.map(
        (day) => (schedule.weekdays?.length ?? 0) > 0
            ? schedule.weekdays!.includes(day)
            : day === new Date(localDateFromIso(schedule.startDate) ?? new Date()).getDay()
    );
    return {
        medicationId: schedule.medicationId,
        doseAmount: schedule.doseAmount.toString(),
        unit: schedule.unit,
        frequencyType: schedule.frequencyType,
        weekdays,
        intervalDays: schedule.intervalDays?.toString() ?? "7",
        timeSlot: slotForTime(schedule.timeOfDay),
        timeOfDay: schedule.timeOfDay,
        startDate: isoDateOnly(schedule.startDate) ?? todayIso,
        active: schedule.active,
    };
}

/** Parses a validated form string into a number (`""` → undefined). */
function parseFormNumber(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
}

/** Converts validated form values into the canonical service input. */
export function toScheduleInput(values: ScheduleFormValues): ScheduleInput {
    // Slot-selected times snap to the slot default; "custom" keeps the typed time.
    const timeOfDay =
        values.timeSlot === "custom"
            ? values.timeOfDay.trim()
            : SLOT_DEFAULTS[values.timeSlot as Exclude<FormTimeSlot, "custom">];
    return {
        medicationId: values.medicationId,
        doseAmount: parseFormNumber(values.doseAmount) ?? Number.NaN,
        unit: values.unit,
        frequencyType: values.frequencyType,
        // Frequency-specific fields: the form validated whichever is in use;
        // the unused one is dropped so the canonical schema can't reject an
        // irrelevant field (e.g. a stale interval while in "daily" mode).
        weekdays:
            values.frequencyType === "weekly"
                ? WEEKDAYS.filter((_, index) => values.weekdays[index])
                : [],
        intervalDays:
            values.frequencyType === "custom_interval"
                ? parseFormNumber(values.intervalDays) ?? Number.NaN
                : undefined,
        timeOfDay,
        startDate: values.startDate.trim(),
        active: values.active,
    };
}

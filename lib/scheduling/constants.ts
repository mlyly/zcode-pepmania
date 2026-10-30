/**
 * Scheduling domain vocabularies (frequencies, weekdays, time-of-day slots)
 * shared by the UI, forms and occurrence engine. (The migration layer keeps
 * its own frozen copies — see `lib/db/migrations.ts`.)
 */
import {Clock, type LucideIcon, Moon, Sun, Sunrise, Sunset} from "lucide-react";

import type {FrequencyType, Weekday} from "@/lib/db/types";

export const FREQUENCY_TYPES = ["daily", "weekly", "custom_interval"] as const;

export const FREQUENCY_LABELS: Record<FrequencyType, string> = {
    daily: "Daily",
    weekly: "Weekly",
    custom_interval: "Custom interval",
};

/** 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const satisfies readonly Weekday[];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
    0: "Sun",
    1: "Mon",
    2: "Tue",
    3: "Wed",
    4: "Thu",
    5: "Fri",
    6: "Sat",
};

export const WEEKDAY_LABELS_LONG: Record<Weekday, string> = {
    0: "Sunday",
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
    6: "Saturday",
};

// ---------------------------------------------------------------------------
// Time-of-day slots
// ---------------------------------------------------------------------------

/**
 * Time-of-day slot ids. The four named slots tile the day (for agenda
 * grouping); `custom` is the form-only choice for a free-form "HH:MM" time.
 */
export type TimeSlotId = "morning" | "afternoon" | "evening" | "night" | "custom";

export interface TimeSlotMeta {
    id: TimeSlotId;
    label: string;
    icon: LucideIcon;
    /** Default "HH:MM" used when the slot is picked in a form. */
    defaultTime: string;
    /** Inclusive start minute-of-day (24h). `night` wraps past midnight. */
    startMinute: number;
    /** Exclusive end minute-of-day. */
    endMinute: number;
}

/** The four named slots, in daily order (custom excluded). */
export const TIME_SLOTS: readonly TimeSlotMeta[] = [
    {
        id: "morning",
        label: "Morning",
        icon: Sunrise,
        defaultTime: "08:00",
        startMinute: 5 * 60,
        endMinute: 12 * 60,
    },
    {
        id: "afternoon",
        label: "Afternoon",
        icon: Sun,
        defaultTime: "14:00",
        startMinute: 12 * 60,
        endMinute: 17 * 60,
    },
    {
        id: "evening",
        label: "Evening",
        icon: Sunset,
        defaultTime: "19:00",
        startMinute: 17 * 60,
        endMinute: 21 * 60,
    },
    {
        id: "night",
        label: "Night",
        icon: Moon,
        defaultTime: "22:00",
        startMinute: 21 * 60,
        endMinute: 5 * 60, // wraps past midnight
    },
];

/** Form entry for a free-form time (not part of the day-tiling). */
export const CUSTOM_SLOT: TimeSlotMeta = {
    id: "custom",
    label: "Custom time",
    icon: Clock,
    defaultTime: "12:00",
    startMinute: 0,
    endMinute: 24 * 60,
};

/**
 * Which named slot a "HH:MM" time falls in — used for agenda grouping.
 * Unparseable times group under `afternoon` (midday) as a neutral bucket.
 */
export function timeSlotFor(timeOfDay: string): TimeSlotMeta {
    const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay.trim());
    if (!match) return TIME_SLOTS[1];
    const minute = Number(match[1]) * 60 + Number(match[2]);
    for (const slot of TIME_SLOTS) {
        if (slot.startMinute < slot.endMinute) {
            if (minute >= slot.startMinute && minute < slot.endMinute) return slot;
        } else if (minute >= slot.startMinute || minute < slot.endMinute) {
            return slot; // wraps midnight
        }
    }
    return TIME_SLOTS[1];
}

/** Minute-of-day of a "HH:MM" time (for ordering occurrences). */
export function timeToMinutes(timeOfDay: string): number {
    const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay.trim());
    if (!match) return 12 * 60;
    return Number(match[1]) * 60 + Number(match[2]);
}

// ---------------------------------------------------------------------------
// Injection sites (dose log module)
// ---------------------------------------------------------------------------

/**
 * Common injection-site presets offered by the dose log form. Unusual sites
 * are accepted free-text ("Other"); the list is intentionally short — presets
 * are a convenience, not a validation.
 */
export const INJECTION_SITES = [
    "Abdomen",
    "Upper arm",
    "Thigh",
    "Lower leg",
    "Buttock",
] as const;

export type InjectionSitePreset = (typeof INJECTION_SITES)[number];

/**
 * Form-state sentinel for "site not recorded". Radix `SelectItem` rejects an
 * empty string as its value, so the no-site choice needs its own id; it
 * resolves to an *unset* field on the saved log.
 */
export const UNSPECIFIED_SITE = "unspecified";

/** Form-state sentinel for the free-text "other site" choice. */
export const CUSTOM_SITE = "other";

/** Maximum length of a free-text injection site. */
export const MAX_SITE_LENGTH = 60;

/**
 * Body-measurements domain constants shared by the UI, forms and service
 * layer (mirrors `lib/medications/constants.ts`). The migration layer keeps
 * its own frozen copies — `MeasurementType.valueKind` is additive and needs
 * no transformation, so nothing is duplicated in `lib/db/migrations.ts`.
 */
import {Activity, HeartPulse, type LucideIcon, Ruler, Scale} from "lucide-react";

import type {MeasurementValueKind} from "@/lib/db/types";

export const MEASUREMENT_VALUE_KINDS = ["numeric", "blood_pressure"] as const;

// ---------------------------------------------------------------------------
// Built-in trackers
// ---------------------------------------------------------------------------

/**
 * Fixed ids for the two default trackers. They are not UUIDs on purpose:
 * seeding is idempotent across databases (fresh, migrated, imported) without
 * a name-collision dance, and `isCustom === false` marks them as protected
 * (never deletable, kind locked).
 */
export const BUILTIN_WEIGHT_ID = "builtin-weight";
export const BUILTIN_BLOOD_PRESSURE_ID = "builtin-blood-pressure";

export interface BuiltinMeasurementType {
    id: string;
    name: string;
    unit: string;
    valueKind: MeasurementValueKind;
    icon: LucideIcon;
    /** Short hint shown on the tracker card when there are no readings yet. */
    emptyHint: string;
}

/** Seed definitions, in display order (built-ins lead the picker row). */
export const BUILTIN_MEASUREMENT_TYPES: readonly BuiltinMeasurementType[] = [
    {
        id: BUILTIN_WEIGHT_ID,
        name: "Weight",
        unit: "kg",
        valueKind: "numeric",
        icon: Scale,
        emptyHint: "Log your weight on the same scale, ideally in the morning.",
    },
    {
        id: BUILTIN_BLOOD_PRESSURE_ID,
        name: "Blood Pressure",
        unit: "mmHg",
        valueKind: "blood_pressure",
        icon: HeartPulse,
        emptyHint: "Record systolic over diastolic, e.g. 120/80.",
    },
];

/** Icon for any tracker: built-ins by id, custom BP by kind, else generic. */
export function measurementTypeIcon(type: {
    id: string;
    valueKind?: MeasurementValueKind;
}): LucideIcon {
    const builtin = BUILTIN_MEASUREMENT_TYPES.find((seed) => seed.id === type.id);
    if (builtin) return builtin.icon;
    return type.valueKind === "blood_pressure" ? Activity : Ruler;
}

export function isBuiltinMeasurementType(id: string): boolean {
    return BUILTIN_MEASUREMENT_TYPES.some((seed) => seed.id === id);
}

// ---------------------------------------------------------------------------
// Custom-type creation presets
// ---------------------------------------------------------------------------

export interface MeasurementTypePreset {
    name: string;
    unit: string;
    valueKind: MeasurementValueKind;
}

/** One-tap starting points in the new-tracker dialog. */
export const MEASUREMENT_TYPE_PRESETS: readonly MeasurementTypePreset[] = [
    {name: "Body Fat", unit: "%", valueKind: "numeric"},
    {name: "Waist Circumference", unit: "cm", valueKind: "numeric"},
    {name: "Blood Glucose", unit: "mmol/L", valueKind: "numeric"},
    {name: "Heart Rate", unit: "bpm", valueKind: "numeric"},
    {name: "Blood Pressure", unit: "mmHg", valueKind: "blood_pressure"},
];

// ---------------------------------------------------------------------------
// Blood pressure
// ---------------------------------------------------------------------------

/** Stored form of a BP reading: `"<systolic>/<diastolic>"`, e.g. "120/80". */
export const BLOOD_PRESSURE_PATTERN = /^(\d{2,3})\/(\d{2,3})$/;

export const SYSTOLIC_RANGE: readonly [number, number] = [50, 300];
export const DIASTOLIC_RANGE: readonly [number, number] = [30, 200];

// ---------------------------------------------------------------------------
// Value bounds (canonical input limits)
// ---------------------------------------------------------------------------

/** Numeric measurements: > 0 and ≤ 1e6 (guards against typos like "72000 kg"). */
export const MAX_MEASUREMENT_VALUE = 1e6;

/** Notes cap, shared with the dose-log module. */
export const MAX_NOTES_LENGTH = 2000;
export const MAX_TYPE_NAME_LENGTH = 60;
export const MAX_UNIT_LENGTH = 20;

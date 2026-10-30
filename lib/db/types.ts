/**
 * Core data schemas (see AGENTS.md §3). All timestamps are ISO strings.
 *
 * Canonical domain constants (type/unit vocabularies) live in
 * `lib/medications/constants.ts`; the migration layer keeps its own frozen
 * copies so schema history never depends on evolving code.
 */

/** Mass-style dose units (convertible to a mg base). */
export type MassUnit = "mg" | "mcg" | "IU";
/** Volume dose unit (only convertible via a reconstitution concentration). */
export type VolumeUnit = "mL";
export type DoseUnit = MassUnit | VolumeUnit;

export type MedicationType =
    | "peptide"
    | "injection"
    | "pill"
    | "liquid"
    | "supplement"
    | "other";

export interface Medication {
    id: string;
    name: string;
    type: MedicationType;
    /** Primary unit for doses, inventory quantities and thresholds. */
    unit: DoseUnit;

    /** Optional reconstitution info for peptides (linked to active schedules). */
    reconstitution?: {
        vialQuantity: number;
        vialQuantityUnit: MassUnit;
        bacWaterAmountMl: number;
    };

    inventory: {
        /**
         * Remaining amount, expressed in `unit`. Derived on every write as
         * `vialCount × containerSize` — never typed in directly.
         */
        currentQuantity: number;
        /** Vials / bottles / packs on hand. */
        vialCount: number;
        /** Amount per container (unit size), in `unit` — e.g. a 5 mg vial. */
        containerSize?: number;
        /** Low-stock alert threshold, in `unit`. */
        lowStockThreshold?: number;
    };

    halfLifeHours?: number;
    notes?: string;
    createdAt: string;
    updatedAt: string;
}

export type FrequencyType = "daily" | "weekly" | "custom_interval";

/** Calendar weekday, 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * v3: `startDate` is a local calendar date ("YYYY-MM-DD"), `weekdays` selects
 * specific days-of-week for the "weekly" frequency (the v3 migration backfills
 * it from `startDate` for pre-v3 rows).
 */
export interface Schedule {
    id: string;
    medicationId: string;
    doseAmount: number;
    unit: DoseUnit;
    frequencyType: FrequencyType;
    /**
     * Days of week that fire when frequencyType === "weekly"
     * (0 = Sunday … 6 = Saturday). Pre-v3 "weekly" rows are backfilled with
     * the weekday of their `startDate`.
     */
    weekdays?: Weekday[];
    /** Whole days between doses; required when frequencyType === "custom_interval". */
    intervalDays?: number;
    /** Local time of day, "HH:MM". */
    timeOfDay: string;
    /** First day the schedule is due, local calendar date "YYYY-MM-DD". */
    startDate: string;
    active: boolean;
}

export interface DoseLog {
    id: string;
    medicationId: string;
    scheduleId?: string;
    doseAmount: number;
    unit: DoseUnit;
    /** ISO datetime — when the dose was actually taken. */
    timestamp: string;
    /**
     * v3: ISO datetime of the scheduled occurrence this log completed. Set
     * when logging from the checklist/calendar; legacy and ad-hoc logs omit
     * it and match occurrences by schedule + same calendar day.
     */
    scheduledFor?: string;
    /**
     * v4: Optional injection site (e.g. "Abdomen"). Free text — the form
     * offers common presets (`lib/scheduling/constants.ts`) plus a free-text
     * "Other"; unusual sites are stored as-typed. Oral and other non-
     * injected doses simply leave it unset.
     */
    injectionSite?: string;
    notes?: string;
}

/** How values for a measurement type are entered and stored. */
export type MeasurementValueKind = "numeric" | "blood_pressure";

export interface MeasurementType {
    id: string;
    name: string;
    unit: string;
    /** Built-in (default) trackers are `false`; user-created ones `true`. */
    isCustom: boolean;
    /**
     * v5: value shape for this type — numeric input or a systolic/diastolic
     * pair (stored as "120/80"). Absent ≡ "numeric" (pre-v5 rows stay valid).
     */
    valueKind?: MeasurementValueKind;
}

export interface MeasurementLog {
    id: string;
    measurementTypeId: string;
    /** Numeric for standard measurements, string allowed for BP ("120/80"). */
    value: number | string;
    /** ISO datetime — when the reading was taken. */
    timestamp: string;
    notes?: string;
}

/** Key/value metadata row; `schema_version` lives here. */
export interface MetaEntry {
    key: string;
    value: number;
}

/** Automatic pre-migration snapshot written by the migration manager. */
export interface BackupEntry {
    id: string;
    kind: "pre-migration" | "manual";
    createdAt: string;
    schemaVersion: number;
    payload: string; // JSON export payload (checksummed)
}

/** The `meta` key under which the applied schema version is stored. */
export const SCHEMA_VERSION_KEY = "schema_version";

export interface DatabaseSnapshot {
    schemaVersion: number;
    medications: Medication[];
    schedules: Schedule[];
    doseLogs: DoseLog[];
    measurementTypes: MeasurementType[];
    measurementLogs: MeasurementLog[];
}

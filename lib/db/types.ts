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
/** Count unit — pills, capsules, patches, etc. Only converts to itself. */
export type CountUnit = "pcs";
export type DoseUnit = MassUnit | VolumeUnit | CountUnit;

export type MedicationType =
    | "peptide"
    | "injection"
    | "pill"
    | "liquid"
    | "supplement"
    | "other";

/**
 * One purchase / delivery lot of a medication.
 *
 * `vialCount` is the number of containers currently on hand for this lot (it
 * is reduced by quick inventory adjustments). `contentAmount` is how much a
 * single container holds, expressed in `contentUnit` — e.g. a 5 mg peptide
 * vial or a 60 pcs bottle of tablets.
 */
export interface InventoryLot {
    id: string;
    /** Containers/vials/bottles currently on hand in this lot. */
    vialCount: number;
    /** Amount of medication in one container, in `contentUnit`. */
    contentAmount: number;
    contentUnit: DoseUnit;
    /** Local calendar date the lot was ordered ("YYYY-MM-DD"). */
    orderDate?: string;
    /** Local calendar date the lot was delivered/expected ("YYYY-MM-DD"). */
    deliveryDate?: string;
    /** Vendor / supplier free text. */
    vendor?: string;
    /** Price paid per container/vial, in USD. */
    pricePerContainer?: number;
    /** Certificate-of-analysis links (http/https). */
    coaUrls?: string[];
    /** Free-text lot notes (batch, storage, etc.). */
    notes?: string;
}

export interface MedicationInventory {
    /** Every stock lot on hand, oldest-first is the preferred consumption order. */
    lots: InventoryLot[];
    /** Low-stock alert threshold, in the medication's dose `unit`. */
    lowStockThreshold?: number;
}

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

    /** Inventory is a set of lots; totals are derived from them on read. */
    inventory: MedicationInventory;

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

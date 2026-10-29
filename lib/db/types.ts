/**
 * Core data schemas (see AGENTS.md §3). All timestamps are ISO strings.
 */

export type MedicationType = "peptide" | "medication" | "supplement";
export type DoseUnit = "mg" | "mcg" | "IU";

export interface Medication {
    id: string;
    name: string;
    type: MedicationType;
    unit: DoseUnit;

    /** Optional reconstitution info for vials. */
    reconstitution?: {
        vialQuantity: number;
        vialQuantityUnit: "mg" | "mcg" | "IU";
        bacWaterAmountMl: number;
    };

    inventory: {
        currentQuantity: number;
        vialCount: number;
        lowStockThreshold?: number;
    };

    halfLifeHours?: number;
    notes?: string;
    createdAt: string;
    updatedAt: string;
}

export type FrequencyType = "daily" | "weekly" | "custom_interval";

export interface Schedule {
    id: string;
    medicationId: string;
    doseAmount: number;
    unit: DoseUnit;
    frequencyType: FrequencyType;
    /** Required when frequencyType === "custom_interval". */
    intervalDays?: number;
    timeOfDay: string; // "HH:MM"
    startDate: string; // ISO date
    active: boolean;
}

export interface DoseLog {
    id: string;
    medicationId: string;
    scheduleId?: string;
    doseAmount: number;
    unit: DoseUnit;
    timestamp: string; // ISO date string
    notes?: string;
}

export interface MeasurementType {
    id: string;
    name: string;
    unit: string;
    isCustom: boolean;
}

export interface MeasurementLog {
    id: string;
    measurementTypeId: string;
    /** Numeric for standard measurements, string allowed for BP ("120/80"). */
    value: number | string;
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

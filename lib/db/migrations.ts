/**
 * A single, sequential schema upgrade step. Versions must be contiguous and
 * start at 1. `up` performs pure data transformations and must be idempotent
 * against partially-migrated data — it runs after the corresponding Dexie
 * schema version has been applied (index creation is atomic), and the schema
 * version in `meta` is only bumped after `up` resolves, so a crash resumes
 * cleanly on the next startup.
 *
 * See AGENTS.md §2.2 for the contract, and the guide for how the pipeline is
 * wired up in `migration-manager.ts`.
 */
import type {PepDatabase} from "./database";
import type {InventoryLot, Medication, MedicationType, Schedule, Weekday} from "./types";

export interface Migration {
    version: number;
    description: string;
    up: (db: unknown) => Promise<void> | void;
    /**
     * Pure-data twin of `up` used by the import path to promote export
     * payloads created by older app versions to the current schema. Must
     * mutate the snapshot in place (same transformation as `up`).
     */
    upSnapshot?: (data: unknown) => void;
}

/** Dexie schema declarations per version, one entry per version. */
export interface SchemaVersion {
    version: number;
    stores: Record<string, string>;
}

export const LATEST_SCHEMA_VERSION = 7;

/**
 * Index declarations. Primary keys (`id`) are non-indexed UUIDs; other fields
 * are indexed for the query patterns used by the app.
 */
export const SCHEMA_VERSIONS: SchemaVersion[] = [
    {
        version: 1,
        stores: {
            medications: "id, name, type, updatedAt",
            schedules: "id, medicationId, active, startDate, [medicationId+active]",
            doseLogs:
                "id, medicationId, scheduleId, timestamp, [medicationId+timestamp]",
            measurementTypes: "id, name",
            measurementLogs:
                "id, measurementTypeId, timestamp, [measurementTypeId+timestamp]",
            meta: "key",
            backups: "id, kind, createdAt",
        },
    },
    {
        // v2 is a pure data migration (granular medication types + optional
        // `inventory.containerSize`) — no index changes, so the accumulated
        // store map is re-declared unchanged.
        version: 2,
        stores: {},
    },
    {
        // v3 adds `Schedule.weekdays` and `DoseLog.scheduledFor` (scheduling
        // module). `scheduledFor` is indexed for occurrence matching; rows
        // without it (legacy/ad-hoc logs) simply stay out of the index.
        version: 3,
        stores: {
            doseLogs:
                "id, medicationId, scheduleId, timestamp, scheduledFor, [medicationId+timestamp]",
        },
    },
    {
        // v4 is a pure schema-shape migration: `DoseLog` gains an optional,
        // non-indexed `injectionSite` string (dose log module). No index
        // changes, so the accumulated store map is re-declared unchanged (as
        // in v2); existing rows simply lack the field until first edited.
        version: 4,
        stores: {},
    },
    {
        // v5 is a pure schema-shape migration: `MeasurementType` gains an
        // optional `valueKind` ("numeric" | "blood_pressure") that drives the
        // body-metrics input shapes and trend charts (measurements module).
        // Additive, non-indexed — absent ≡ "numeric", so existing rows and
        // re-imported payloads validate unchanged.
        version: 5,
        stores: {},
    },
    {
        // v6 replaces the single aggregate `inventory` object with a list of
        // stock lots (vials × content per vial, order/delivery dates, vendor,
        // COA links and notes). Nested data needs no index changes.
        version: 6,
        stores: {},
    },
    {
        // v7 adds an optional `pricePerContainer` to each inventory lot. It is
        // additive and non-indexed, so no store map changes are needed.
        version: 7,
        stores: {},
    },
];

/**
 * Frozen v1 → v2 medication-type mapping. Migrations must never import from
 * living domain code, so this table is intentionally local and immutable: the
 * generic legacy `"medication"` tag becomes `"pill"` (the most common form),
 * and any unrecognized value collapses to `"other"`.
 */
const TYPE_REMAP_V2: Record<string, MedicationType> = {
    medication: "pill",
    peptide: "peptide",
    injection: "injection",
    pill: "pill",
    liquid: "liquid",
    supplement: "supplement",
    other: "other",
};

function remapTypeV2(raw: unknown): MedicationType {
    return typeof raw === "string" ? TYPE_REMAP_V2[raw] ?? "other" : "other";
}

// ---------------------------------------------------------------------------
// v3 helpers (frozen — migrations must never import from living domain code)
// ---------------------------------------------------------------------------

interface LocalDateParts {
    year: number;
    /** 1–12 */
    month: number;
    /** 1–31 */
    day: number;
}

/**
 * Parses a stored schedule `startDate` into LOCAL calendar date parts.
 * Date-only strings are split on their hyphens (never `new Date()`, which
 * would interpret them as UTC midnight); full ISO instants use the local
 * `Date` getters. Returns null for unparseable values.
 */
function parseLocalDateParts(value: unknown): LocalDateParts | null {
    if (typeof value !== "string" || value.trim() === "") return null;
    const trimmed = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
    if (dateOnly) {
        const [year, month, day] = dateOnly[0].split("-").map(Number);
        if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
            return null;
        }
        return {year, month, day};
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return null;
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
    };
}

function formatLocalDateParts(parts: LocalDateParts): string {
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Calendar weekday (0 = Sunday … 6 = Saturday) of local date parts. */
function weekdayOfParts(parts: LocalDateParts): Weekday {
    return new Date(parts.year, parts.month - 1, parts.day).getDay() as Weekday;
}

// ---------------------------------------------------------------------------
// v6 helpers (frozen — migrations must never import from living domain code)
// ---------------------------------------------------------------------------

const DOSE_UNIT_VALUES_V6 = ["mg", "mcg", "IU", "mL", "pcs"] as const;
type DoseUnitV6 = (typeof DOSE_UNIT_VALUES_V6)[number];
const MASS_UNIT_VALUES_V6 = ["mg", "mcg", "IU"] as const;
type MassUnitV6 = (typeof MASS_UNIT_VALUES_V6)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function finiteNumber(value: unknown): number | undefined {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
}

function positiveNumber(value: unknown): number | undefined {
    const number = finiteNumber(value);
    return number !== undefined && number > 0 ? number : undefined;
}

function isDoseUnitV6(value: unknown): value is DoseUnitV6 {
    return typeof value === "string" && (DOSE_UNIT_VALUES_V6 as readonly string[]).includes(value);
}

function isMassUnitV6(value: unknown): value is MassUnitV6 {
    return typeof value === "string" && (MASS_UNIT_VALUES_V6 as readonly string[]).includes(value);
}

/**
 * Folds the pre-v6 single inventory object into one lot. Existing v6 rows
 * (already carrying a `lots` array) pass through untouched, which keeps the
 * migration idempotent after a crash.
 */
function migrateInventoryV6(record: Record<string, unknown>, fallbackId: string): void {
    const rawInventory = asRecord(record.inventory);
    if (!rawInventory) {
        record.inventory = {lots: []};
        return;
    }
    if (Array.isArray(rawInventory.lots)) return; // already migrated

    const unit: DoseUnitV6 = isDoseUnitV6(record.unit) ? record.unit : "mg";
    let vialCount = Math.max(0, Math.trunc(finiteNumber(rawInventory.vialCount) ?? 0));
    const currentQuantity = positiveNumber(rawInventory.currentQuantity);

    let contentAmount = positiveNumber(rawInventory.containerSize);
    let contentUnit: DoseUnitV6 = unit;

    // Volume-dosed peptides stored BAC water as the container size; the more
    // useful lot description is the peptide mass per vial from reconstitution.
    const reconstitution = asRecord(record.reconstitution);
    const reconQuantity = positiveNumber(reconstitution?.vialQuantity);
    if (unit === "mL" && reconQuantity !== undefined && isMassUnitV6(reconstitution?.vialQuantityUnit)) {
        contentAmount = reconQuantity;
        contentUnit = reconstitution!.vialQuantityUnit as MassUnitV6;
    }

    if (contentAmount === undefined && currentQuantity !== undefined) {
        contentAmount = vialCount > 0 ? currentQuantity / vialCount : currentQuantity;
        if (vialCount === 0) vialCount = 1;
    }
    if (vialCount === 0 && currentQuantity !== undefined) {
        // Legacy rows without a container size tracked an absolute total.
        vialCount = 1;
    }

    const lowStockThreshold = finiteNumber(rawInventory.lowStockThreshold);
    const lots: InventoryLot[] = [];
    if (vialCount > 0 && contentAmount !== undefined && contentAmount > 0) {
        const medicationId = typeof record.id === "string" && record.id ? record.id : fallbackId;
        lots.push({
            id: `${medicationId}-legacy-lot`,
            vialCount,
            contentAmount,
            contentUnit,
        });
    }

    record.inventory = {
        lots,
        ...(lowStockThreshold !== undefined && lowStockThreshold >= 0
            ? {lowStockThreshold}
            : {}),
    };
}

/**
 * Data migrations, ordered by version. Version 1 has no data migration —
 * fresh databases are created directly at the latest version. The pipeline
 * (pre-migration backup + sequential apply + idempotent resume) is exercised
 * by `scripts/storage-smoke.ts`, `scripts/medications-smoke.ts` and
 * `scripts/scheduling-smoke.ts` and may be extended with further versions.
 */
export const MIGRATIONS: Migration[] = [
    {
        version: 2,
        description:
            "Granular medication types (peptide/injection/pill/liquid/supplement/other) " +
            "replace the legacy generic 'medication' tag; dose units gain mL; " +
            "inventory gains an optional per-container size.",
        up: async (target) => {
            const database = target as PepDatabase;
            await database.transaction("rw", database.medications, async () => {
                const medications = await database.medications.toArray();
                for (const medication of medications) {
                    const type = remapTypeV2(medication.type);
                    if (type !== medication.type) {
                        await database.medications.update(medication.id, {
                            type,
                        } satisfies Partial<Medication>);
                    }
                }
            });
        },
        upSnapshot: (data) => {
            const snapshot = data as { medications?: unknown[] };
            if (!Array.isArray(snapshot.medications)) return;
            for (const row of snapshot.medications) {
                if (row === null || typeof row !== "object") continue;
                const record = row as { type?: unknown };
                record.type = remapTypeV2(record.type);
            }
        },
    },
    {
        version: 3,
        description:
            "Scheduling module: 'weekly' frequencies gain specific days-of-week " +
            "(`Schedule.weekdays`, backfilled from the schedule's start date); " +
            "dose logs gain `scheduledFor` for occurrence matching; schedule " +
            "start dates normalize to local calendar dates (YYYY-MM-DD).",
        up: async (target) => {
            const database = target as PepDatabase;
            await database.transaction("rw", database.schedules, async () => {
                const schedules = await database.schedules.toArray();
                for (const schedule of schedules) {
                    const parts = parseLocalDateParts(schedule.startDate);
                    const patch: Partial<Schedule> = {};
                    if (parts) {
                        const canonical = formatLocalDateParts(parts);
                        if (schedule.startDate !== canonical) {
                            patch.startDate = canonical;
                        }
                        if (
                            schedule.frequencyType === "weekly" &&
                            (!schedule.weekdays || schedule.weekdays.length === 0)
                        ) {
                            // Pre-v3 "weekly" meant "once a week, anchored on the
                            // start date" — pin it to that day-of-week.
                            patch.weekdays = [weekdayOfParts(parts)];
                        }
                    }
                    if (Object.keys(patch).length > 0) {
                        await database.schedules.update(schedule.id, patch);
                    }
                }
            });
        },
        upSnapshot: (data) => {
            const snapshot = data as { schedules?: unknown[] };
            if (!Array.isArray(snapshot.schedules)) return;
            for (const row of snapshot.schedules) {
                if (row === null || typeof row !== "object") continue;
                const record = row as {
                    frequencyType?: unknown;
                    weekdays?: unknown;
                    startDate?: unknown;
                };
                const parts = parseLocalDateParts(record.startDate);
                if (!parts) continue;
                const canonical = formatLocalDateParts(parts);
                if (typeof record.startDate === "string" && record.startDate !== canonical) {
                    record.startDate = canonical;
                }
                if (record.frequencyType === "weekly") {
                    const original = Array.isArray(record.weekdays) ? record.weekdays : [];
                    const weekdays = original.filter(
                        (w): w is number => typeof w === "number" && w >= 0 && w <= 6
                    );
                    if (weekdays.length === 0) {
                        record.weekdays = [weekdayOfParts(parts)];
                    } else if (weekdays.length !== original.length) {
                        // Invalid entries (out of range) were dropped.
                        record.weekdays = weekdays;
                    }
                }
            }
        },
    },
    {
        version: 4,
        description:
            "Dose log module: dose logs gain an optional `injectionSite` " +
            "string (additive — existing rows stay valid and are simply unset).",
        up: () => {
            // Additive optional field: nothing to transform on the live database.
        },
        upSnapshot: () => {
            // Additive optional field: import payloads from older versions are
            // accepted as-is (absent `injectionSite` ≡ unset).
        },
    },
    {
        version: 5,
        description:
            "Body measurements module: measurement types gain an optional " +
            "`valueKind` ('numeric' | 'blood_pressure') driving the input " +
            "shape and trend charts (additive — absent ≡ 'numeric').",
        up: () => {
            // Additive optional field: nothing to transform on the live
            // database. Built-in trackers (Weight, Blood Pressure) are seeded
            // lazily and idempotently by the measurements service, which also
            // covers fresh databases (created straight at the latest version)
            // and imported payloads.
        },
        upSnapshot: () => {
            // Additive optional field: import payloads from older versions are
            // accepted as-is (absent `valueKind` ≡ "numeric").
        },
    },
    {
        version: 6,
        description:
            "Inventory lots: the single aggregate inventory becomes a list of " +
            "lots (vials × content per vial, order/delivery dates, vendor, COA " +
            "links, notes). Legacy totals are folded into one synthetic lot.",
        up: async (target) => {
            const database = target as PepDatabase;
            await database.transaction("rw", database.medications, async () => {
                const medications = await database.medications.toArray();
                for (const medication of medications) {
                    const record = medication as unknown as Record<string, unknown>;
                    migrateInventoryV6(record, medication.id);
                    await database.medications.update(medication.id, {
                        inventory: record.inventory as Medication["inventory"],
                    } satisfies Partial<Medication>);
                }
            });
        },
        upSnapshot: (data) => {
            const snapshot = data as { medications?: unknown[] };
            if (!Array.isArray(snapshot.medications)) return;
            snapshot.medications.forEach((row, index) => {
                const record = asRecord(row);
                if (!record) return;
                migrateInventoryV6(record, `legacy-medication-${index}`);
            });
        },
    },
    {
        version: 7,
        description:
            "Inventory pricing: each lot gains an optional `pricePerContainer` " +
            "(USD per vial/container). Additive — existing lots stay valid and " +
            "are simply unpriced.",
        up: () => {
            // Additive optional field: nothing to transform on the live database.
        },
        upSnapshot: () => {
            // Additive optional field: import payloads from older versions are
            // accepted as-is (absent `pricePerContainer` ≡ unpriced).
        },
    },
];

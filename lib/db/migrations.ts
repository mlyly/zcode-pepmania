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
import type {Medication, MedicationType, Schedule, Weekday} from "./types";

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

export const LATEST_SCHEMA_VERSION = 3;

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
];

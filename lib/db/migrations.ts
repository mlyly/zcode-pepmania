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
import type {Medication, MedicationType} from "./types";

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

export const LATEST_SCHEMA_VERSION = 2;

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

/**
 * Data migrations, ordered by version. Version 1 has no data migration —
 * fresh databases are created directly at the latest version. The pipeline
 * (pre-migration backup + sequential apply + idempotent resume) is exercised
 * by `scripts/storage-smoke.ts` and `scripts/medications-smoke.ts` and may be
 * extended with further versions.
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
];

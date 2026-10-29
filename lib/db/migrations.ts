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
export interface Migration {
    version: number;
    description: string;
    up: (db: unknown) => Promise<void> | void;
}

/** Dexie schema declarations per version, one entry per version. */
export interface SchemaVersion {
    version: number;
    stores: Record<string, string>;
}

export const LATEST_SCHEMA_VERSION = 1;

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
];

/**
 * Data migrations, ordered by version. Version 1 has no data migration —
 * fresh databases are created directly at the latest version. The pipeline
 * (pre-migration backup + sequential apply + idempotent resume) is exercised
 * by `scripts/storage-smoke.ts` and may be extended with further versions.
 */
export const MIGRATIONS: Migration[] = [];

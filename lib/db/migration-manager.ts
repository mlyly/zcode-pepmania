import {db} from "./database";
import {buildExportPayload} from "./export";
import {LATEST_SCHEMA_VERSION, MIGRATIONS} from "./migrations";
import {type BackupEntry, SCHEMA_VERSION_KEY} from "./types";

/** Keep at most this many automatic pre-migration backups. */
const MAX_AUTO_BACKUPS = 5;

export interface MigrationResult {
    from: number;
    to: number;
    applied: number[];
    backupId?: string;
}

/**
 * Runs the migration pipeline (AGENTS.md §2.2):
 *
 *  1. Open the database — Dexie applies declared schema versions (index
 *     creation) atomically while upgrading.
 *  2. Read `meta.schema_version`; no-op when already current.
 *  3. Before applying any pending migration, write an automatic pre-migration
 *     backup snapshot into the `backups` table (capped at MAX_AUTO_BACKUPS).
 *  4. Apply each data migration sequentially, oldest → newest, stamping the
 *     reached version into `meta` after each step resolves so a crash resumes
 *     cleanly on the next startup.
 *
 * Idempotent: safe to call on every boot (the app does, see `index.ts`).
 */
export async function runMigrations(): Promise<MigrationResult> {
    await db.open();

    const stored = await db.meta.get(SCHEMA_VERSION_KEY);
    const from = stored?.value ?? null;

    if (from === LATEST_SCHEMA_VERSION) {
        return {from, to: from, applied: []};
    }

    if (from !== null && from > LATEST_SCHEMA_VERSION) {
        // The browser has data from a *newer* app version (roll-back install).
        throw new Error(
            `Local database schema v${from} is newer than this app build (v${LATEST_SCHEMA_VERSION}). Update the app before opening it — refusing to run to avoid corrupting data.`
        );
    }

    let backupId: string | undefined;

    if (from !== null && from < LATEST_SCHEMA_VERSION) {
        // Auto-backup before migrations (AGENTS.md §6.4).
        const payload = await buildExportPayload();
        backupId = `pre-migration-${Date.now()}`;
        await db.backups.add({
            id: backupId,
            kind: "pre-migration",
            createdAt: new Date().toISOString(),
            schemaVersion: from,
            payload: JSON.stringify(payload),
        } satisfies BackupEntry);
        await pruneAutoBackups();
    }

    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
        if (migration.version > (from ?? 0) && migration.version <= LATEST_SCHEMA_VERSION) {
            await migration.up(db);
            // Stamp only after success, so an interrupted step re-runs next boot.
            await db.meta.put({key: SCHEMA_VERSION_KEY, value: migration.version});
            applied.push(migration.version);
        }
    }

    if (from === null) {
        // Fresh database (or legacy database without a meta row).
        await db.meta.put({key: SCHEMA_VERSION_KEY, value: LATEST_SCHEMA_VERSION});
    }

    return {from: from ?? 0, to: LATEST_SCHEMA_VERSION, applied, backupId};
}

async function pruneAutoBackups(): Promise<void> {
    const autoBackups = await db.backups
        .where("kind")
        .equals("pre-migration")
        .toArray();
    autoBackups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const stale = autoBackups.slice(MAX_AUTO_BACKUPS).map((b) => b.id);
    if (stale.length > 0) await db.backups.bulkDelete(stale);
}

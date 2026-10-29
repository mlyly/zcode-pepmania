import Dexie, {type Table} from "dexie";

import {SCHEMA_VERSIONS} from "./migrations";
import type {BackupEntry, DoseLog, MeasurementLog, MeasurementType, Medication, MetaEntry, Schedule,} from "./types";

export const DATABASE_NAME = "peptimania";

export class PepDatabase extends Dexie {
    medications!: Table<Medication, string>;
    schedules!: Table<Schedule, string>;
    doseLogs!: Table<DoseLog, string>;
    measurementTypes!: Table<MeasurementType, string>;
    measurementLogs!: Table<MeasurementLog, string>;
    meta!: Table<MetaEntry, string>;
    backups!: Table<BackupEntry, string>;

    constructor() {
        super(DATABASE_NAME);

        // One Dexie version per declared schema version. Every `version()` call
        // must include the full (accumulated) store map because Dexie versions
        // are declarative deltas applied in order — we keep the full map in each
        // entry so index changes show up as explicit diffs between versions.
        let accumulated: Record<string, string> = {};
        for (const {version, stores} of SCHEMA_VERSIONS) {
            accumulated = {...accumulated, ...stores};
            this.version(version).stores(accumulated);
        }
    }
}

/**
 * Singleton instance. Call `ensureDatabase()` (from `migration-manager.ts`)
 * before first use instead of touching `db.open()` directly, so migrations
 * and the pre-migration backup run in the right order.
 */
export const db = new PepDatabase();

export type PepDatabaseType = PepDatabase;

import {type Table} from "dexie";

import {db} from "./database";
import {LATEST_SCHEMA_VERSION, MIGRATIONS} from "./migrations";
import type {DatabaseSnapshot} from "./types";

export const EXPORT_APP_ID = "pepmania-pwa";
export const EXPORT_FORMAT_VERSION = 1;

interface ExportData {
    schemaVersion: number;
    medications: unknown[];
    schedules: unknown[];
    doseLogs: unknown[];
    measurementTypes: unknown[];
    measurementLogs: unknown[];
}

export interface ExportPayload {
    app: string;
    formatVersion: number;
    exportedAt: string;
    data: ExportData;
    /** SHA-256 (hex) over the canonical JSON of `data`. */
    checksum: string;
}

export class ImportError extends Error {
    constructor(
        message: string,
        readonly code:
            | "bad-json"
            | "wrong-app"
            | "unknown-format"
            | "checksum-mismatch"
            | "schema-too-new"
    ) {
        super(message);
        this.name = "ImportError";
    }
}

/** Deterministic JSON (recursively sorted keys) so checksums are stable. */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/** Reads every domain table into a plain snapshot object. */
export async function snapshotDatabase(): Promise<DatabaseSnapshot> {
    const [medications, schedules, doseLogs, measurementTypes, measurementLogs] =
        await Promise.all([
            db.medications.toArray(),
            db.schedules.toArray(),
            db.doseLogs.toArray(),
            db.measurementTypes.toArray(),
            db.measurementLogs.toArray(),
        ]);
    return {
        schemaVersion: LATEST_SCHEMA_VERSION,
        medications,
        schedules,
        doseLogs,
        measurementTypes,
        measurementLogs,
    };
}

/** Builds a checksummed export payload from a snapshot of the live database. */
export async function buildExportPayload(): Promise<ExportPayload> {
    const data = await snapshotDatabase();
    const checksum = await sha256Hex(canonicalize(data));
    return {
        app: EXPORT_APP_ID,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
            schemaVersion: data.schemaVersion,
            medications: data.medications,
            schedules: data.schedules,
            doseLogs: data.doseLogs,
            measurementTypes: data.measurementTypes,
            measurementLogs: data.measurementLogs,
        },
        checksum,
    };
}

/** Validates an import payload, including checksum + schema migration checks. */
export async function validateExportPayload(raw: string): Promise<ExportPayload> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ImportError("File is not valid JSON.", "bad-json");
    }

    const payload = parsed as Partial<ExportPayload> | null;
    if (!payload || payload.app !== EXPORT_APP_ID) {
        throw new ImportError(
            "This file was not exported from Peptimania.",
            "wrong-app"
        );
    }
    if (payload.formatVersion !== EXPORT_FORMAT_VERSION || !payload.data) {
        throw new ImportError("Unsupported export format version.", "unknown-format");
    }

    const recomputed = await sha256Hex(canonicalize(payload.data));
    if (recomputed !== payload.checksum) {
        throw new ImportError(
            "Checksum mismatch — the file may be corrupted or tampered with.",
            "checksum-mismatch"
        );
    }

    const schemaVersion = payload.data.schemaVersion ?? 0;
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
        throw new ImportError(
            "This export was created by a newer app version. Update the app first.",
            "schema-too-new"
        );
    }
    if (schemaVersion < LATEST_SCHEMA_VERSION) {
        // Future-compatible hook: each Migration may declare a pure-data
        // `upSnapshot` used to upgrade import payloads older than the app.
        const promotable = MIGRATIONS.every(
            (m) => m.version > schemaVersion && typeof (m as MigrationLike).upSnapshot === "function"
        );
        if (!promotable && schemaVersion < LATEST_SCHEMA_VERSION) {
            throw new ImportError(
                `Export schema v${schemaVersion} is older than the app (v${LATEST_SCHEMA_VERSION}). Upgrade the payload's data in the app first.`,
                "unknown-format"
            );
        }
        // Apply snapshot migrations oldest → newest.
        for (const m of MIGRATIONS) {
            if (m.version > schemaVersion) {
                const withSnapshot = m as MigrationLike;
                withSnapshot.upSnapshot?.(payload.data);
                payload.data.schemaVersion = m.version;
            }
        }
    }

    return payload as ExportPayload;
}

/** Writes validated payload data into the database (replace or merge). */
export async function writeImportedPayload(
    payload: ExportPayload,
    mode: "replace" | "merge"
): Promise<void> {
    const tables: [Table<unknown, string>, unknown[]][] = [
        [db.medications, payload.data.medications],
        [db.schedules, payload.data.schedules],
        [db.doseLogs, payload.data.doseLogs],
        [db.measurementTypes, payload.data.measurementTypes],
        [db.measurementLogs, payload.data.measurementLogs],
    ];

    await db.transaction("rw", tables.map(([table]) => table), async () => {
        if (mode === "replace") {
            await Promise.all(tables.map(([table]) => table.clear()));
        }
        for (const [table, rows] of tables) {
            if (rows.length > 0) await table.bulkPut(rows);
        }
    });
}

/** Counts each domain table so the UI can show what an export will include. */
export interface ExportStats {
    medications: number;
    schedules: number;
    doseLogs: number;
    measurementTypes: number;
    measurementLogs: number;
}

export async function getExportStats(): Promise<ExportStats> {
    const [medications, schedules, doseLogs, measurementTypes, measurementLogs] =
        await Promise.all([
            db.medications.count(),
            db.schedules.count(),
            db.doseLogs.count(),
            db.measurementTypes.count(),
            db.measurementLogs.count(),
        ]);
    return {medications, schedules, doseLogs, measurementTypes, measurementLogs};
}

export interface ImportSummary {
    exportedAt: string;
    schemaVersion: number;
    /** N undefined → not reported by the payload. */
    counts: Omit<ExportStats, "schemaVersion">;
}

/** Human-readable preview of a validated payload for the confirmation UI. */
export function summarizePayload(payload: ExportPayload): ImportSummary {
    return {
        exportedAt: payload.exportedAt,
        schemaVersion: payload.data.schemaVersion ?? 0,
        counts: {
            medications: (payload.data.medications ?? []).length,
            schedules: (payload.data.schedules ?? []).length,
            doseLogs: (payload.data.doseLogs ?? []).length,
            measurementTypes: (payload.data.measurementTypes ?? []).length,
            measurementLogs: (payload.data.measurementLogs ?? []).length,
        },
    };
}


type MigrationLike = {
    version: number;
    up: (db: unknown) => Promise<void> | void;
    upSnapshot?: (data: unknown) => void;
};

/** Triggers a browser download of a plain-text/JSON file. 100% local. */
export function downloadJsonString(content: string, filename: string): void {
    const blob = new Blob([content], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** Triggers a browser download of the given payload as a JSON file. */
export function downloadExport(payload: ExportPayload): void {
    downloadJsonString(
        JSON.stringify(payload, null, 2),
        exportFilename(payload.exportedAt, false)
    );
}

/** Canonical backup file name; encrypted files get the `.enc` marker. */
export function exportFilename(exportedAtIso: string, encrypted: boolean): string {
    const stamp = exportedAtIso.slice(0, 10) ||
        new Date().toISOString().slice(0, 10);
    return `peptimania-backup-${stamp}${encrypted ? ".enc" : ""}.json`;
}

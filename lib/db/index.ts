import {type MigrationResult, runMigrations} from "./migration-manager";

export * from "./types";
export * from "./database";
export * from "./migrations";
export * from "./migration-manager";
export * from "./export";
export * from "./cryptography";
export * from "./wipe";

let inFlight: Promise<MigrationResult> | null = null;

/**
 * One-call database bootstrap for the app shell. Runs the migration pipeline
 * exactly once per page load (subsequent calls await the same promise).
 *
 * ```ts
 * const result = await ensureDatabase(); // idempotent on every boot
 * ```
 */
export function ensureDatabase(): Promise<MigrationResult> {
    inFlight ??= runMigrations().catch((error) => {
        // Allow a retry after a failure (e.g. transient quota issue).
        inFlight = null;
        throw error;
    });
    return inFlight;
}

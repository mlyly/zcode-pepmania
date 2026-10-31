/**
 * Smoke test for the IndexedDB storage layer, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/storage-smoke.ts
 *
 * Exercises: migration pipeline, version stamping, checksummed export,
 * tampered-payload rejection, and replace-mode import.
 */
import "fake-indexeddb/auto";

import {
    buildExportPayload,
    db,
    ensureDatabase,
    LATEST_SCHEMA_VERSION,
    validateExportPayload,
    writeImportedPayload,
} from "../lib/db";

let failed = false;

async function expectError(label: string, fn: () => Promise<unknown>) {
    try {
        await fn();
        console.error(`✗ ${label}: expected an error but none thrown`);
        failed = true;
    } catch (error) {
        console.log(`✓ ${label}: ${error instanceof Error ? error.message : error}`);
    }
}

async function main() {
    const result = await ensureDatabase();
    console.log("migration result:", result);

    if (result.to !== LATEST_SCHEMA_VERSION) {
        console.error("✗ schema version stamp mismatch");
        failed = true;
    } else {
        console.log(`✓ meta.schema_version = ${LATEST_SCHEMA_VERSION}`);
    }

    // Persist a sample medication and export it.
    const now = new Date().toISOString();
    await db.medications.put({
        id: "test-med-1",
        name: "BPC-157",
        type: "peptide",
        unit: "mcg",
        reconstitution: {
            vialQuantity: 5,
            vialQuantityUnit: "mg",
            bacWaterAmountMl: 2,
        },
        inventory: {
            lots: [{id: "lot-1", vialCount: 1, contentAmount: 5, contentUnit: "mcg"}],
            lowStockThreshold: 1,
        },
        halfLifeHours: 4,
        createdAt: now,
        updatedAt: now,
    });

    const payload = await buildExportPayload();
    console.log(`export checksum: ${payload.checksum.slice(0, 16)}…`);

    // Well-formed payload round-trips.
    const validated = await validateExportPayload(JSON.stringify(payload));
    await db.medications.clear();
    await writeImportedPayload(validated, "replace");
    const count = await db.medications.count();
    if (count === 1) {
        console.log("✓ replace-mode import restored 1 medication");
    } else {
        console.error(`✗ expected 1 medication after reimport, got ${count}`);
        failed = true;
    }

    // Tampered payloads must be rejected.
    await expectError("checksum mismatch detected", async () => {
        await validateExportPayload(
            JSON.stringify({...payload, checksum: "deadbeef"})
        );
    });
    await expectError("foreign payload rejected", () =>
        validateExportPayload(JSON.stringify({...payload, app: "someone-else"}))
    );
    await expectError("corrupt JSON rejected", () =>
        validateExportPayload("{not json")
    );

    if (failed) {
        console.error("\nSmoke test FAILED");
        process.exit(1);
    }
    console.log("\nSmoke test passed");
    process.exit(0);
}

main().catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
});

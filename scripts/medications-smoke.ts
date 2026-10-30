/**
 * Smoke test for the medication module, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/medications-smoke.ts
 *
 * Exercises: the v1 → v2 data migration (legacy type remap + snapshot twin),
 * service CRUD (zod-validated, PUT semantics), inventory adjustments, delete
 * cascade, and the reconstitution/stock derived math.
 */
import "fake-indexeddb/auto";

import {
    buildExportPayload,
    db,
    ensureDatabase,
    LATEST_SCHEMA_VERSION,
    type Medication,
    MIGRATIONS,
    runMigrations,
    SCHEMA_VERSION_KEY,
} from "../lib/db";
import {
    activeSchedulesFor,
    concentrationLabel,
    dailyAmountInUnit,
    daysOfStockRemaining,
    dosesPerVial,
    doseVolumeMl,
    inventoryStatus,
    reconstitutionConcentration,
    stockRatio,
} from "../lib/medications/derived";
import type {MedicationInput} from "../lib/medications/schema";
import {medicationFormSchema, medicationToFormValues, toMedicationInput,} from "../lib/medications/schema";
import {
    adjustInventory,
    countLinkedRecords,
    createMedication,
    deleteMedication,
    updateMedication,
} from "../lib/medications/service";
import {convertUnit, mlToSyringeUnits} from "../lib/units";

let failed = false;

function check(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`✓ ${label}`);
    } else {
        console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
        failed = true;
    }
}

async function expectError(label: string, fn: () => Promise<unknown>) {
    try {
        await fn();
        console.error(`✗ ${label}: expected an error but none thrown`);
        failed = true;
    } catch (error) {
        console.log(`✓ ${label}: ${error instanceof Error ? error.message : error}`);
    }
}

const now = new Date().toISOString();

async function main() {
    // ------------------------------------------------------------------ v2
    const result = await ensureDatabase();
    check(
        "fresh database stamps schema v5",
        result.to === LATEST_SCHEMA_VERSION && LATEST_SCHEMA_VERSION === 5,
        `got ${result.to}`
    );

    // ------------------------------------------------- v1 → v2 migration
    // Simulate a legacy database: v1 meta row + generic "medication" row.
    await db.medications.clear();
    await db.meta.put({key: SCHEMA_VERSION_KEY, value: 1});
    const legacyMedications: Medication[] = [
        {
            id: "legacy-1",
            name: "Metformin",
            type: "medication" as Medication["type"],
            unit: "mg",
            inventory: {currentQuantity: 60, vialCount: 1, lowStockThreshold: 10},
            createdAt: now,
            updatedAt: now,
        },
        {
            id: "legacy-2",
            name: "BPC-157",
            type: "peptide",
            unit: "mcg",
            reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 2},
            inventory: {currentQuantity: 5, vialCount: 1},
            createdAt: now,
            updatedAt: now,
        },
        {
            id: "legacy-3",
            name: "Mystery",
            type: "weird-legacy-value" as Medication["type"],
            unit: "mg",
            inventory: {currentQuantity: 1, vialCount: 1},
            createdAt: now,
            updatedAt: now,
        },
    ];
    await db.medications.bulkPut(legacyMedications);

    const migrated = await runMigrations();
    const afterMigration = await db.medications.toArray();
    const byId = new Map(afterMigration.map((m) => [m.id, m]));
    check(
        "migration reports v1 → v5 (v2 + v3 + v4 + v5 applied)",
        migrated.from === 1 && migrated.to === 5,
        `got ${migrated.from} → ${migrated.to}`
    );
    check(
        "legacy 'medication' remapped to 'pill'",
        byId.get("legacy-1")?.type === "pill",
        `got ${byId.get("legacy-1")?.type}`
    );
    check("valid types pass through untouched", byId.get("legacy-2")?.type === "peptide");
    check(
        "unknown types collapse to 'other'",
        byId.get("legacy-3")?.type === "other",
        `got ${byId.get("legacy-3")?.type}`
    );
    check(
        "pre-migration backup was written",
        migrated.backupId !== undefined && (await db.backups.get(migrated.backupId!)) !== undefined
    );

    // Snapshot twin (used by the import path to promote old payloads).
    const snapshot = {
        schemaVersion: 1,
        medications: [
            {id: "a", type: "medication"},
            {id: "b", type: "peptide"},
            {id: "c", type: "junk"},
        ],
    };
    MIGRATIONS[0].upSnapshot?.(snapshot);
    check(
        "upSnapshot promotes legacy payload types",
        snapshot.medications.map((m) => m.type).join(",") === "pill,peptide,other",
        `got ${snapshot.medications.map((m) => m.type).join(",")}`
    );

    // Exports must still round-trip at the current schema.
    const payload = await buildExportPayload();
    check(
        "export carries the current schema",
        payload.data.schemaVersion === LATEST_SCHEMA_VERSION &&
        payload.data.medications.length === 3
    );

    // ------------------------------------------------------- unit math
    check("1 mg → 1,000 mcg", convertUnit(1, "mg", "mcg")?.value === 1000);
    check("2,500 mcg → 2.5 mg", convertUnit(2500, "mcg", "mg")?.value === 2.5);
    check("IU conversion flags fallback", convertUnit(100, "IU", "mg")?.iuFallback === true);
    check("mL has no direct conversion", convertUnit(1, "mL", "mg") === null);
    check("0.1 mL = 10 U-100 units", mlToSyringeUnits(0.1) === 10);

    // --------------------------------------------------------- service
    await db.medications.clear();
    const bpcInput: MedicationInput = {
        name: "BPC-157",
        type: "peptide",
        unit: "mcg",
        halfLifeHours: 4,
        inventory: {
            vialCount: 1,
            containerSize: 5000,
            lowStockThreshold: 1000,
        },
        reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 2},
        notes: "Morning injection",
    };
    const created = await createMedication(bpcInput);
    check("create stores and timestamps the row", created.id.length > 0 && created.createdAt === created.updatedAt);
    check(
        "stock derives from vials × per-vial",
        created.inventory.currentQuantity === 5000,
        `got ${created.inventory.currentQuantity}`
    );

    await expectError("non-positive per-vial amount rejected", () =>
        createMedication({
            ...bpcInput,
            name: "Bad",
            inventory: {...bpcInput.inventory, containerSize: 0},
        })
    );
    await expectError("reconstitution with zero BAC water rejected", () =>
        createMedication({
            ...bpcInput,
            reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 0},
        })
    );

    // PUT semantics: update without reconstitution clears it.
    const updated = await updateMedication(created.id, {
        ...bpcInput,
        name: "BPC-157 (5 mg vials)",
        halfLifeHours: undefined,
        reconstitution: undefined,
        notes: undefined,
    });
    check("update applies PUT semantics", updated.name === "BPC-157 (5 mg vials)");
    check("update clears optional fields", updated.reconstitution === undefined && updated.halfLifeHours === undefined && updated.notes === undefined);
    check("update bumps updatedAt", updated.updatedAt > updated.createdAt);

    // Restore full record for derived-math checks.
    const full = await updateMedication(created.id, bpcInput);

    // Inventory stepper.
    await adjustInventory(full.id, 5000, 1);
    let adjusted = await db.medications.get(full.id);
    check("stepper adds a container", adjusted?.inventory.currentQuantity === 10000 && adjusted?.inventory.vialCount === 2);
    await adjustInventory(full.id, -100000, -10);
    adjusted = await db.medications.get(full.id);
    check("stepper clamps at zero", adjusted?.inventory.currentQuantity === 0 && adjusted?.inventory.vialCount === 0);
    await adjustInventory(full.id, 5000, 1);

    // --------------------------------------------------- derived math
    const bpc = (await db.medications.get(full.id))!;
    const concentration = reconstitutionConcentration(bpc);
    check(
        "concentration = 2.5 mg/mL (2,500 mcg/mL)",
        concentration?.mgPerMl === 2.5 && concentration?.perMlInDoseUnit === 2500
    );
    check(
        "concentration label renders mcg + mg",
        concentrationLabel(bpc)?.primary === "2,500 mcg/mL" &&
        concentrationLabel(bpc)?.secondary === "2.5 mg/mL"
    );
    check("dose volume for 250 mcg = 0.1 mL", doseVolumeMl(250, "mcg", bpc) === 0.1);
    check("one 5 mg vial holds 20 × 250 mcg doses", dosesPerVial(250, "mcg", bpc) === 20);

    const schedules = [
        {
            id: "sched-1",
            medicationId: bpc.id,
            doseAmount: 250,
            unit: "mcg" as const,
            frequencyType: "daily" as const,
            timeOfDay: "08:00",
            startDate: now,
            active: true,
        },
        {
            id: "sched-2",
            medicationId: bpc.id,
            doseAmount: 250,
            unit: "mcg" as const,
            frequencyType: "weekly" as const,
            timeOfDay: "20:00",
            startDate: now,
            active: false,
        },
    ];
    check("active schedule filter", activeSchedulesFor(schedules, bpc.id).length === 1);
    check("daily usage = 250 mcg/day", dailyAmountInUnit(bpc, schedules) === 250);
    check(
        "stock covers 20 days",
        daysOfStockRemaining(bpc, schedules) === 20,
        `got ${daysOfStockRemaining(bpc, schedules)}`
    );

    const stocked: Medication = {
        ...bpc,
        inventory: {currentQuantity: 5000, vialCount: 1, lowStockThreshold: 1000},
    };
    check("status ok above threshold", inventoryStatus(stocked) === "ok");
    check(
        "status low at threshold",
        inventoryStatus({...stocked, inventory: {...stocked.inventory, currentQuantity: 1000}}) === "low"
    );
    check("status out at zero", inventoryStatus({
        ...stocked,
        inventory: {...stocked.inventory, currentQuantity: 0}
    }) === "out");
    const ratio = stockRatio({...stocked, inventory: {...stocked.inventory, currentQuantity: 1000}});
    check("stock ratio hits 50% at the threshold", Math.abs(ratio - 0.5) < 1e-9, `got ${ratio}`);

    // ------------------------------------------------- form schema pipeline
    const formValues = medicationToFormValues(); // create-mode defaults
    const invalidForm = medicationFormSchema.safeParse(formValues);
    check(
        "blank form rejected (name + per-vial required)",
        !invalidForm.success &&
        JSON.stringify(invalidForm.error.issues.map((i) => i.path.join("."))).includes("name") &&
        JSON.stringify(invalidForm.error.issues.map((i) => i.path.join("."))).includes("containerSize")
    );

    const peptideForm = medicationToFormValues();
    Object.assign(peptideForm, {
        name: "BPC-157",
        type: "peptide",
        unit: "mcg",
        vialCount: "1",
        containerSize: "5000",
        lowStockThreshold: "1000",
        halfLifeHours: "4",
        hasReconstitution: true,
        // Ignored for mass-dosed peptides — the vial mass comes from the
        // per-vial inventory amount instead of these fields.
        vialQuantity: "5",
        vialQuantityUnit: "mg",
        bacWaterAmountMl: "2",
        notes: "  Morning injection  ",
    } satisfies Partial<typeof peptideForm>);
    const validForm = medicationFormSchema.safeParse(peptideForm);
    check("complete peptide form parses", validForm.success);
    const peptideInput = toMedicationInput(validForm.success ? validForm.data : peptideForm);
    check(
        "form converts to canonical input",
        peptideInput.name === "BPC-157" &&
        peptideInput.halfLifeHours === 4 &&
        peptideInput.inventory.vialCount === 1 &&
        peptideInput.inventory.containerSize === 5000 &&
        peptideInput.reconstitution?.vialQuantity === 5000 &&
        peptideInput.reconstitution?.vialQuantityUnit === "mcg" &&
        peptideInput.notes === "Morning injection"
    );

    const missingRecon = medicationFormSchema.safeParse({
        ...peptideForm,
        bacWaterAmountMl: "",
    });
    check(
        "BAC water required when reconstitution enabled",
        !missingRecon.success &&
        missingRecon.error.issues.some((i) => i.path[0] === "bacWaterAmountMl")
    );

    // mL-dosed peptides: the vial mass is typed, the per-vial stock volume
    // comes from the BAC water.
    const mlForm = medicationToFormValues();
    Object.assign(mlForm, {
        name: "mL peptide",
        type: "peptide",
        unit: "mL",
        vialCount: "2",
        containerSize: "",
        hasReconstitution: true,
        vialQuantity: "5",
        vialQuantityUnit: "mg",
        bacWaterAmountMl: "2",
    } satisfies Partial<typeof mlForm>);
    const mlParsed = medicationFormSchema.safeParse(mlForm);
    check("mL peptide form parses without a typed per-vial amount", mlParsed.success);
    const mlInput = toMedicationInput(mlParsed.success ? mlParsed.data : mlForm);
    check(
        "mL peptide sizes vials from BAC water",
        mlInput.inventory.containerSize === 2 &&
        mlInput.reconstitution?.vialQuantity === 5 &&
        mlInput.reconstitution?.vialQuantityUnit === "mg"
    );
    const mlCreated = await createMedication(mlInput);
    check(
        "mL peptide stock derives from vials × BAC water",
        mlCreated.inventory.currentQuantity === 4,
        `got ${mlCreated.inventory.currentQuantity}`
    );
    await deleteMedication(mlCreated.id);

    const missingMlMass = medicationFormSchema.safeParse({...mlForm, vialQuantity: ""});
    check(
        "mL reconstitution still requires the vial mass",
        !missingMlMass.success &&
        missingMlMass.error.issues.some((i) => i.path[0] === "vialQuantity")
    );

    // Legacy rows (no container size) prefill a per-vial amount that keeps
    // the stored total intact.
    const prefilled = medicationToFormValues({
        id: "prefill-1",
        name: "Metformin",
        type: "pill",
        unit: "mg",
        inventory: {currentQuantity: 60, vialCount: 1},
        createdAt: now,
        updatedAt: now,
    });
    check(
        "edit prefill sizes per-vial from stored stock",
        prefilled.containerSize === "60",
        `got ${prefilled.containerSize}`
    );

    const badNumbers = medicationFormSchema.safeParse({
        ...peptideForm,
        containerSize: "-1",
        vialCount: "1.5",
        halfLifeHours: "abc",
    });
    check(
        "numeric rules produce field errors",
        !badNumbers.success &&
        badNumbers.error.issues.some((i) => i.path[0] === "containerSize") &&
        badNumbers.error.issues.some((i) => i.path[0] === "vialCount") &&
        badNumbers.error.issues.some((i) => i.path[0] === "halfLifeHours")
    );

    const pillForm = {...peptideForm, type: "pill" as const, hasReconstitution: true};
    const pillParsed = medicationFormSchema.safeParse(pillForm);
    const pillInput = toMedicationInput(pillParsed.success ? pillParsed.data : pillForm);
    check(
        "non-peptide types drop reconstitution on submit",
        pillInput.type === "pill" && pillInput.reconstitution === undefined
    );

    // The service accepts the converted input end-to-end.
    const fromForm = await createMedication(peptideInput);
    check(
        "service accepts form-converted input",
        fromForm.reconstitution?.vialQuantity === 5000 &&
        fromForm.reconstitution?.vialQuantityUnit === "mcg" &&
        fromForm.inventory.currentQuantity === 5000
    );
    await deleteMedication(fromForm.id);

    // --------------------------------------------------- delete cascade
    await db.schedules.bulkPut(schedules.map((s) => ({...s, intervalDays: undefined})));
    await db.doseLogs.put({
        id: "log-1",
        medicationId: bpc.id,
        scheduleId: "sched-1",
        doseAmount: 250,
        unit: "mcg",
        timestamp: now,
    });
    const linked = await countLinkedRecords(bpc.id);
    check("linked records counted", linked.schedules === 2 && linked.doseLogs === 1);
    const deletedCounts = await deleteMedication(bpc.id);
    check(
        "delete cascades schedules and logs",
        deletedCounts.schedules === 2 &&
        deletedCounts.doseLogs === 1 &&
        (await db.medications.get(bpc.id)) === undefined &&
        (await db.schedules.where("medicationId").equals(bpc.id).count()) === 0 &&
        (await db.doseLogs.where("medicationId").equals(bpc.id).count()) === 0
    );

    if (failed) {
        console.error("\nMedication smoke test FAILED");
        process.exit(1);
    }
    console.log("\nMedication smoke test passed");
    process.exit(0);
}

main().catch((error) => {
    console.error("Smoke test crashed:", error);
    process.exit(1);
});

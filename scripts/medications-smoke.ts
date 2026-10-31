/**
 * Smoke test for the medication module, runnable in Node via tsx +
 * fake-indexeddb (no browser needed):
 *
 *   npx tsx scripts/medications-smoke.ts
 *
 * Exercises: the v1 → v7 data migration (legacy type remap + inventory lot
 * folding + snapshot twin), service CRUD (zod-validated, PUT semantics),
 * multi-lot inventory adjustments, lot pricing, delete cascade, and the
 * reconstitution / stock derived math.
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
    amountInMedicationUnit,
    concentrationLabel,
    dailyAmountInUnit,
    daysOfStockRemaining,
    dosesPerVial,
    doseVolumeMl,
    formatStockDuration,
    inventoryPriceTotals,
    inventoryQuantity,
    inventoryStatus,
    inventoryTotals,
    lotTotalPrice,
    reconstitutionConcentration,
    stockRatio,
} from "../lib/medications/derived";
import type {MedicationInput} from "../lib/medications/schema";
import {
    medicationFormSchema,
    medicationToFormValues,
    newInventoryLotFormValues,
    toMedicationInput,
} from "../lib/medications/schema";
import {
    adjustInventory,
    countLinkedRecords,
    createMedication,
    deleteMedication,
    updateMedication,
} from "../lib/medications/service";
import {convertUnit, mlToSyringeUnits, mlToWholeSyringeUnits} from "../lib/units";

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
    // ------------------------------------------------------------ v7
    const result = await ensureDatabase();
    check(
        "fresh database stamps schema v7",
        result.to === LATEST_SCHEMA_VERSION && LATEST_SCHEMA_VERSION === 7,
        `got ${result.to}`
    );

    // ------------------------------------------------- v1 → v7 migration
    // Simulate a legacy database: v1 meta row + generic "medication" rows with
    // the pre-v6 aggregate inventory object.
    await db.medications.clear();
    await db.meta.put({key: SCHEMA_VERSION_KEY, value: 1});
    const legacyMedications = [
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
        {
            id: "legacy-4",
            name: "mL peptide",
            type: "peptide",
            unit: "mL",
            reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 2},
            inventory: {currentQuantity: 4, vialCount: 2, containerSize: 2},
            createdAt: now,
            updatedAt: now,
        },
    ] as unknown as Medication[];
    await db.medications.bulkPut(legacyMedications);

    const migrated = await runMigrations();
    const afterMigration = await db.medications.toArray();
    const byId = new Map(afterMigration.map((m) => [m.id, m]));
    check(
        "migration reports v1 → v7",
        migrated.from === 1 &&
        migrated.to === 7 &&
        migrated.applied.join() === "2,3,4,5,6,7",
        `got ${migrated.from} → ${migrated.to} (${migrated.applied.join()})`
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
    const legacyLot = byId.get("legacy-1")?.inventory;
    check(
        "legacy inventory folds into one synthetic lot",
        legacyLot?.lots.length === 1 &&
        legacyLot.lots[0].vialCount === 1 &&
        legacyLot.lots[0].contentAmount === 60 &&
        legacyLot.lots[0].contentUnit === "mg" &&
        legacyLot.lowStockThreshold === 10,
        JSON.stringify(legacyLot)
    );
    const legacyMl = byId.get("legacy-4")?.inventory;
    check(
        "mL peptide lot records the vial mass from reconstitution",
        legacyMl?.lots.length === 1 &&
        legacyMl.lots[0].vialCount === 2 &&
        legacyMl.lots[0].contentAmount === 5 &&
        legacyMl.lots[0].contentUnit === "mg",
        JSON.stringify(legacyMl)
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

    const snapshotV6 = {
        schemaVersion: 5,
        medications: [
            {
                id: "snap-1",
                unit: "mg",
                type: "pill",
                inventory: {currentQuantity: 30, vialCount: 2, lowStockThreshold: 5},
            },
        ],
    };
    MIGRATIONS.find((m) => m.version === 6)?.upSnapshot?.(snapshotV6);
    const snapInventory = (snapshotV6.medications[0] as unknown as Medication).inventory;
    check(
        "v6 upSnapshot folds legacy inventory into lots",
        snapInventory.lots.length === 1 &&
        snapInventory.lots[0].vialCount === 2 &&
        snapInventory.lots[0].contentAmount === 15 &&
        snapInventory.lowStockThreshold === 5,
        JSON.stringify(snapInventory)
    );

    const snapshotV7 = {
        schemaVersion: 6,
        medications: [
            {
                id: "snap-pricing",
                inventory: {
                    lots: [
                        {id: "p1", vialCount: 1, contentAmount: 5, contentUnit: "mg"},
                    ],
                },
            },
        ],
    };
    const beforeV7 = JSON.stringify(snapshotV7);
    MIGRATIONS.find((m) => m.version === 7)?.upSnapshot?.(snapshotV7);
    check("v7 is additive: unpriced lots pass through untouched", JSON.stringify(snapshotV7) === beforeV7);

    // Exports must still round-trip at the current schema.
    const payload = await buildExportPayload();
    check(
        "export carries the current schema",
        payload.data.schemaVersion === LATEST_SCHEMA_VERSION &&
        payload.data.medications.length === 4
    );

    // ------------------------------------------------------- unit math
    check("1 mg → 1,000 mcg", convertUnit(1, "mg", "mcg")?.value === 1000);
    check("2,500 mcg → 2.5 mg", convertUnit(2500, "mcg", "mg")?.value === 2.5);
    check("IU conversion flags fallback", convertUnit(100, "IU", "mg")?.iuFallback === true);
    check("mL has no direct conversion", convertUnit(1, "mL", "mg") === null);
    check("pcs only converts to itself", convertUnit(5, "pcs", "pcs")?.value === 5 &&
        convertUnit(5, "pcs", "mg") === null);
    check("0.1 mL = 10 U-100 units", mlToSyringeUnits(0.1) === 10);
    check("displayed units round up", mlToWholeSyringeUnits(0.105) === 11);
    check("displayed units keep whole values", mlToWholeSyringeUnits(0.1) === 10);
    check("float noise does not bump the displayed units", mlToWholeSyringeUnits(0.07) === 7);

    // --------------------------------------------------------- service
    await db.medications.clear();
    const bpcInput: MedicationInput = {
        name: "BPC-157",
        type: "peptide",
        unit: "mcg",
        halfLifeHours: 4,
        inventory: {
            lots: [
                {
                    id: "bpc-lot-1",
                    vialCount: 1,
                    contentAmount: 5000,
                    contentUnit: "mcg",
                    pricePerContainer: 25,
                },
            ],
            lowStockThreshold: 1000,
        },
        reconstitution: {vialQuantity: 5, vialQuantityUnit: "mg", bacWaterAmountMl: 2},
        notes: "Morning injection",
    };
    const created = await createMedication(bpcInput);
    check("create stores and timestamps the row", created.id.length > 0 && created.createdAt === created.updatedAt);
    check(
        "stock derives from lot containers × content",
        inventoryQuantity(created) === 5000,
        `got ${inventoryQuantity(created)}`
    );
    check(
        "lot pricing persists and totals per container",
        created.inventory.lots[0].pricePerContainer === 25 &&
        lotTotalPrice(created.inventory.lots[0]) === 25 &&
        inventoryPriceTotals(created).totalPrice === 25,
        JSON.stringify(created.inventory.lots[0])
    );

    await expectError("non-positive container content rejected", () =>
        createMedication({
            ...bpcInput,
            name: "Bad",
            inventory: {
                ...bpcInput.inventory,
                lots: [{...bpcInput.inventory.lots[0], contentAmount: 0}],
            },
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

    // Inventory stepper: +1 container tops up, large removals clamp at zero.
    await adjustInventory(full.id, 1);
    let adjusted = await db.medications.get(full.id);
    check(
        "stepper adds a container",
        adjusted !== undefined && inventoryQuantity(adjusted) === 10000 &&
        adjusted.inventory.lots[0].vialCount === 2,
        JSON.stringify(adjusted?.inventory)
    );
    await adjustInventory(full.id, -10);
    adjusted = await db.medications.get(full.id);
    check(
        "stepper clamps at zero",
        adjusted !== undefined && inventoryQuantity(adjusted) === 0 &&
        inventoryTotals(adjusted).vialCount === 0,
        JSON.stringify(adjusted?.inventory)
    );
    await adjustInventory(full.id, 1);

    // FIFO / newest-first with dated lots.
    const dated = await createMedication({
        name: "FIFO test",
        type: "pill",
        unit: "pcs",
        inventory: {
            lots: [
                {
                    id: "old-lot",
                    vialCount: 2,
                    contentAmount: 30,
                    contentUnit: "pcs",
                    deliveryDate: "2026-01-01",
                },
                {
                    id: "new-lot",
                    vialCount: 1,
                    contentAmount: 30,
                    contentUnit: "pcs",
                    deliveryDate: "2026-02-01",
                },
            ],
        },
    });
    const afterFifo = await adjustInventory(dated.id, -2);
    check(
        "removal consumes the oldest lot first",
        afterFifo.inventory.lots.find((lot) => lot.id === "old-lot")?.vialCount === 0 &&
        afterFifo.inventory.lots.find((lot) => lot.id === "new-lot")?.vialCount === 1
    );
    const afterTopUp = await adjustInventory(dated.id, 1);
    check(
        "addition tops up the newest lot",
        afterTopUp.inventory.lots.find((lot) => lot.id === "new-lot")?.vialCount === 2 &&
        afterTopUp.inventory.lots.find((lot) => lot.id === "old-lot")?.vialCount === 0
    );
    await deleteMedication(dated.id);

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
    check("duration formatting", formatStockDuration(20) === "20 days" &&
        formatStockDuration(0.5) === "< 1 day" &&
        formatStockDuration(60) === "2 mo" &&
        formatStockDuration(800) === "2 yr 2 mo",
        `${formatStockDuration(20)} / ${formatStockDuration(60)} / ${formatStockDuration(800)}`);

    // Multi-lot totals convert mass and reconstituted volume, and flag the
    // lots that have no path to the medication unit.
    const multiLot: Medication = {
        ...bpc,
        inventory: {
            lots: [
                {id: "m1", vialCount: 2, contentAmount: 5, contentUnit: "mg", pricePerContainer: 10},
                {id: "m2", vialCount: 1, contentAmount: 1000, contentUnit: "mcg", pricePerContainer: 20},
                {id: "m3", vialCount: 2, contentAmount: 2, contentUnit: "mL"},
                {id: "m4", vialCount: 1, contentAmount: 10, contentUnit: "pcs"},
            ],
            lowStockThreshold: 1000,
        },
    };
    const multiTotals = inventoryTotals(multiLot);
    check(
        "multi-lot totals convert mg, mcg and reconstructed mL",
        multiTotals.quantity === 21000 &&
        multiTotals.vialCount === 6 &&
        multiTotals.lotCount === 4 &&
        multiTotals.unconvertibleLots === 1,
        JSON.stringify(multiTotals)
    );
    check(
        "amount conversion handles volume via reconstitution",
        amountInMedicationUnit(2, "mL", bpc)?.value === 5000,
        `got ${amountInMedicationUnit(2, "mL", bpc)?.value}`
    );
    const multiPrices = inventoryPriceTotals(multiLot);
    check(
        "price totals sum priced lots and flag unpriced ones",
        multiPrices.totalPrice === 40 &&
        multiPrices.pricedLots === 2 &&
        multiPrices.unpricedLots === 2,
        JSON.stringify(multiPrices)
    );

    const stocked: Medication = {
        ...bpc,
        inventory: {
            lots: [{id: "s1", vialCount: 1, contentAmount: 5000, contentUnit: "mcg"}],
            lowStockThreshold: 1000,
        },
    };
    check("status ok above threshold", inventoryStatus(stocked) === "ok");
    check(
        "status low at threshold",
        inventoryStatus({
            ...stocked,
            inventory: {
                ...stocked.inventory,
                lots: [{...stocked.inventory.lots[0], contentAmount: 1000}],
            },
        }) === "low"
    );
    check("status out at zero", inventoryStatus({
        ...stocked,
        inventory: {lots: [{...stocked.inventory.lots[0], vialCount: 0}]},
    }) === "out");
    const ratio = stockRatio({
        ...stocked,
        inventory: {
            ...stocked.inventory,
            lots: [{...stocked.inventory.lots[0], contentAmount: 1000}],
        },
    });
    check("stock ratio hits 50% at the threshold", Math.abs(ratio - 0.5) < 1e-9, `got ${ratio}`);

    // ------------------------------------------------- form schema pipeline
    const formValues = medicationToFormValues(); // create-mode defaults
    const invalidForm = medicationFormSchema.safeParse(formValues);
    check(
        "blank form rejected (name + lot content required)",
        !invalidForm.success &&
        JSON.stringify(invalidForm.error.issues.map((i) => i.path.join("."))).includes("name") &&
        JSON.stringify(invalidForm.error.issues.map((i) => i.path.join("."))).includes("inventoryLots.0.contentAmount")
    );

    const peptideForm = medicationToFormValues();
    Object.assign(peptideForm, {
        name: "BPC-157",
        type: "peptide",
        unit: "mcg",
        lowStockThreshold: "1000",
        halfLifeHours: "4",
        hasReconstitution: true,
        // The vial mass is explicit and independent of the inventory lots.
        vialQuantity: "5",
        vialQuantityUnit: "mg",
        bacWaterAmountMl: "2",
        notes: "  Morning injection  ",
    });
    peptideForm.inventoryLots = [
        {
            ...newInventoryLotFormValues("mcg"),
            id: "lot-form-1",
            vialCount: "1",
            contentAmount: "5000",
            contentUnit: "mcg",
            orderDate: "2026-01-02",
            deliveryDate: "2026-01-05",
            vendor: "  Example Labs  ",
            pricePerContainer: "12.5",
            coaUrlsText: "example.com/coa\nhttps://example.org/coa",
            notes: "  Batch A  ",
        },
    ];
    const validForm = medicationFormSchema.safeParse(peptideForm);
    check("complete peptide form parses", validForm.success);
    const peptideInput = toMedicationInput(validForm.success ? validForm.data : peptideForm);
    const peptideLot = peptideInput.inventory.lots[0];
    check(
        "form converts to canonical input",
        peptideInput.name === "BPC-157" &&
        peptideInput.halfLifeHours === 4 &&
        peptideInput.inventory.lots.length === 1 &&
        peptideLot.vialCount === 1 &&
        peptideLot.contentAmount === 5000 &&
        peptideLot.contentUnit === "mcg" &&
        peptideLot.orderDate === "2026-01-02" &&
        peptideLot.deliveryDate === "2026-01-05" &&
        peptideLot.vendor === "Example Labs" &&
        peptideLot.pricePerContainer === 12.5 &&
        peptideLot.notes === "Batch A" &&
        peptideInput.reconstitution?.vialQuantity === 5 &&
        peptideInput.reconstitution?.vialQuantityUnit === "mg" &&
        peptideInput.notes === "Morning injection"
    );
    check(
        "COA links normalize and de-duplicate",
        JSON.stringify(peptideLot.coaUrls) ===
        JSON.stringify(["https://example.com/coa", "https://example.org/coa"]),
        JSON.stringify(peptideLot.coaUrls)
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

    const missingVialMass = medicationFormSchema.safeParse({...peptideForm, vialQuantity: ""});
    check(
        "reconstitution requires an explicit vial mass",
        !missingVialMass.success &&
        missingVialMass.error.issues.some((i) => i.path[0] === "vialQuantity")
    );

    const badDates = medicationFormSchema.safeParse({
        ...peptideForm,
        inventoryLots: [
            {
                ...peptideForm.inventoryLots[0],
                orderDate: "2026-02-10",
                deliveryDate: "2026-02-01",
            },
        ],
    });
    check(
        "delivery before order is rejected",
        !badDates.success &&
        badDates.error.issues.some((i) => i.path.join(".") === "inventoryLots.0.deliveryDate")
    );

    const badCoa = medicationFormSchema.safeParse({
        ...peptideForm,
        inventoryLots: [
            {
                ...peptideForm.inventoryLots[0],
                coaUrlsText: "javascript:alert(1)",
            },
        ],
    });
    check(
        "non-http COA links are rejected",
        !badCoa.success &&
        badCoa.error.issues.some((i) => i.path.join(".") === "inventoryLots.0.coaUrlsText")
    );

    const badPrice = medicationFormSchema.safeParse({
        ...peptideForm,
        inventoryLots: [
            {
                ...peptideForm.inventoryLots[0],
                pricePerContainer: "-1",
            },
        ],
    });
    check(
        "negative lot prices are rejected",
        !badPrice.success &&
        badPrice.error.issues.some((i) => i.path.join(".") === "inventoryLots.0.pricePerContainer")
    );

    // mL-dosed peptides: the lot content is the volume in each container,
    // while reconstitution still needs the explicit peptide mass.
    const mlForm = medicationToFormValues();
    Object.assign(mlForm, {
        name: "mL peptide",
        type: "peptide",
        unit: "mL",
        hasReconstitution: true,
        vialQuantity: "5",
        vialQuantityUnit: "mg",
        bacWaterAmountMl: "2",
    });
    mlForm.inventoryLots = [
        {
            ...newInventoryLotFormValues("mL"),
            id: "ml-lot",
            vialCount: "2",
            contentAmount: "2",
            contentUnit: "mL",
        },
    ];
    const mlParsed = medicationFormSchema.safeParse(mlForm);
    check("mL peptide form parses", mlParsed.success);
    const mlInput = toMedicationInput(mlParsed.success ? mlParsed.data : mlForm);
    check(
        "mL peptide lot stores volume per container",
        mlInput.inventory.lots[0].contentAmount === 2 &&
        mlInput.inventory.lots[0].contentUnit === "mL" &&
        mlInput.reconstitution?.vialQuantity === 5 &&
        mlInput.reconstitution?.vialQuantityUnit === "mg"
    );
    const mlCreated = await createMedication(mlInput);
    check(
        "mL peptide stock derives from containers × volume",
        inventoryQuantity(mlCreated) === 4,
        `got ${inventoryQuantity(mlCreated)}`
    );
    await deleteMedication(mlCreated.id);

    // Edit prefill preserves every lot field.
    const prefilled = medicationToFormValues({
        id: "prefill-1",
        name: "Metformin",
        type: "pill",
        unit: "mg",
        inventory: {
            lots: [
                {
                    id: "prefill-lot",
                    vialCount: 1,
                    contentAmount: 60,
                    contentUnit: "mg",
                    vendor: "Pharmacy",
                    pricePerContainer: 18.75,
                },
            ],
        },
        createdAt: now,
        updatedAt: now,
    });
    check(
        "edit prefill restores lot rows",
        prefilled.inventoryLots.length === 1 &&
        prefilled.inventoryLots[0].id === "prefill-lot" &&
        prefilled.inventoryLots[0].vialCount === "1" &&
        prefilled.inventoryLots[0].contentAmount === "60" &&
        prefilled.inventoryLots[0].contentUnit === "mg" &&
        prefilled.inventoryLots[0].vendor === "Pharmacy" &&
        prefilled.inventoryLots[0].pricePerContainer === "18.75",
        JSON.stringify(prefilled.inventoryLots)
    );

    const badNumbers = medicationFormSchema.safeParse({
        ...peptideForm,
        halfLifeHours: "abc",
        inventoryLots: [
            {
                ...peptideForm.inventoryLots[0],
                vialCount: "1.5",
                contentAmount: "-1",
            },
        ],
    });
    check(
        "numeric rules produce field errors",
        !badNumbers.success &&
        badNumbers.error.issues.some((i) => i.path.join(".") === "inventoryLots.0.contentAmount") &&
        badNumbers.error.issues.some((i) => i.path.join(".") === "inventoryLots.0.vialCount") &&
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
        fromForm.reconstitution?.vialQuantity === 5 &&
        fromForm.reconstitution?.vialQuantityUnit === "mg" &&
        inventoryQuantity(fromForm) === 5000
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

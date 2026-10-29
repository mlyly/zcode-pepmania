/**
 * Medication CRUD on top of Dexie. Every write is validated with the
 * canonical zod schema (defense in depth behind the form) and stamped with
 * `updatedAt`. Deleting a medication cascades to its schedules and dose logs
 * so no orphaned references remain.
 *
 * The caller is responsible for having run `ensureDatabase()` first (the
 * medications page gates rendering on it, mirroring the settings page).
 */
import {db, type Medication, type Schedule} from "@/lib/db";
import {roundAmount} from "@/lib/units";
import {type MedicationInput, medicationInputSchema} from "./schema";

function newId(): string {
    return crypto.randomUUID();
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Stock on hand is always derived: containers × amount per container
 * (rounded to trim float noise). Validated upstream by the zod schema.
 */
function derivedStock(inventory: {
    vialCount: number;
    containerSize: number;
}): number {
    return roundAmount(inventory.vialCount * inventory.containerSize);
}

export async function listMedications(): Promise<Medication[]> {
    return db.medications.toArray();
}

export async function listSchedules(): Promise<Schedule[]> {
    return db.schedules.toArray();
}

export async function getMedication(id: string): Promise<Medication | undefined> {
    return db.medications.get(id);
}

export async function createMedication(input: MedicationInput): Promise<Medication> {
    const parsed = medicationInputSchema.parse(input);
    const timestamp = nowIso();
    const medication: Medication = {
        id: newId(),
        name: parsed.name,
        type: parsed.type,
        unit: parsed.unit,
        reconstitution: parsed.reconstitution,
        inventory: {
            currentQuantity: derivedStock(parsed.inventory),
            vialCount: parsed.inventory.vialCount,
            containerSize: parsed.inventory.containerSize,
            lowStockThreshold: parsed.inventory.lowStockThreshold,
        },
        halfLifeHours: parsed.halfLifeHours,
        notes: parsed.notes,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    await db.medications.put(medication);
    return medication;
}

export async function updateMedication(
    id: string,
    input: MedicationInput
): Promise<Medication> {
    const parsed = medicationInputSchema.parse(input);
    const existing = await db.medications.get(id);
    if (!existing) throw new Error("Medication not found — it may have been deleted.");

    // Full replace (PUT) semantics: optional fields the input leaves unset are
    // cleared, so the dialog can remove a reconstitution or a threshold.
    const medication: Medication = {
        id,
        name: parsed.name,
        type: parsed.type,
        unit: parsed.unit,
        reconstitution: parsed.reconstitution,
        inventory: {
            currentQuantity: derivedStock(parsed.inventory),
            vialCount: parsed.inventory.vialCount,
            containerSize: parsed.inventory.containerSize,
            lowStockThreshold: parsed.inventory.lowStockThreshold,
        },
        halfLifeHours: parsed.halfLifeHours,
        notes: parsed.notes,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
    };
    await db.medications.put(medication);
    return medication;
}

export interface LinkedRecordCounts {
    schedules: number;
    doseLogs: number;
}

/** Counts schedules and dose logs referencing a medication (for delete UX). */
export async function countLinkedRecords(id: string): Promise<LinkedRecordCounts> {
    const [schedules, doseLogs] = await Promise.all([
        db.schedules.where("medicationId").equals(id).count(),
        db.doseLogs.where("medicationId").equals(id).count(),
    ]);
    return {schedules, doseLogs};
}

/** Deletes a medication plus its schedules and dose logs, atomically. */
export async function deleteMedication(id: string): Promise<LinkedRecordCounts> {
    return db.transaction(
        "rw",
        [db.medications, db.schedules, db.doseLogs],
        async () => {
            const counts = await countLinkedRecords(id);
            await db.schedules.where("medicationId").equals(id).delete();
            await db.doseLogs.where("medicationId").equals(id).delete();
            await db.medications.delete(id);
            return counts;
        }
    );
}

/**
 * Quick inventory adjustment used by the card stepper. Rows with a per-container
 * size always derive stock from the container count (`vials × size`), so
 * `vialDelta` alone moves the total; legacy rows without a size fall back to
 * the plain `quantityDelta`. Counts clamp at zero and floats are rounded to
 * avoid accumulated noise.
 */
export async function adjustInventory(
    id: string,
    quantityDelta: number,
    vialDelta = 0
): Promise<Medication> {
    return db.transaction("rw", db.medications, async () => {
        const existing = await db.medications.get(id);
        if (!existing) throw new Error("Medication not found — it may have been deleted.");

        const {currentQuantity, vialCount, containerSize} = existing.inventory;
        const nextVialCount = Math.max(0, vialCount + vialDelta);
        const nextQuantity =
            containerSize !== undefined
                ? roundAmount(nextVialCount * containerSize)
                : roundAmount(Math.max(0, currentQuantity + quantityDelta));

        const medication: Medication = {
            ...existing,
            inventory: {
                ...existing.inventory,
                currentQuantity: nextQuantity,
                vialCount: nextVialCount,
            },
            updatedAt: nowIso(),
        };
        await db.medications.put(medication);
        return medication;
    });
}

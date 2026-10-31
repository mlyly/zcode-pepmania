/**
 * Medication CRUD on top of Dexie. Every write is validated with the
 * canonical zod schema (defense in depth behind the form) and stamped with
 * `updatedAt`. Deleting a medication cascades to its schedules and dose logs
 * so no orphaned references remain.
 *
 * The caller is responsible for having run `ensureDatabase()` first (the
 * medications page gates rendering on it, mirroring the settings page).
 */
import {db, type InventoryLot, type Medication, type Schedule} from "@/lib/db";
import {type MedicationInput, medicationInputSchema} from "./schema";

function newId(): string {
    return crypto.randomUUID();
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Assigns ids to new lot rows and trims PUT-cleared optional fields into
 * omitted keys. Validated upstream by the zod schema.
 */
function normalizeLots(lots: MedicationInput["inventory"]["lots"]): InventoryLot[] {
    return lots.map((lot) => ({
        id: lot.id ?? newId(),
        vialCount: lot.vialCount,
        contentAmount: lot.contentAmount,
        contentUnit: lot.contentUnit,
        orderDate: lot.orderDate,
        deliveryDate: lot.deliveryDate,
        vendor: lot.vendor,
        pricePerContainer: lot.pricePerContainer,
        coaUrls: lot.coaUrls,
        notes: lot.notes,
    }));
}

function inventoryFromInput(input: MedicationInput): Medication["inventory"] {
    return {
        lots: normalizeLots(input.inventory.lots),
        lowStockThreshold: input.inventory.lowStockThreshold,
    };
}

/** Sort key for FIFO consumption / newest-first additions. */
function lotDateKey(lot: InventoryLot): string {
    return lot.deliveryDate ?? lot.orderDate ?? "";
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
        inventory: inventoryFromInput(parsed),
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
        inventory: inventoryFromInput(parsed),
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
 * Quick inventory adjustment used by the card stepper: moves whole containers
 * between lots. Consuming removes from the oldest lot first (FIFO); adding
 * tops up the newest lot. Counts clamp at zero.
 */
export async function adjustInventory(
    id: string,
    vialDelta: number
): Promise<Medication> {
    return db.transaction("rw", db.medications, async () => {
        const existing = await db.medications.get(id);
        if (!existing) throw new Error("Medication not found — it may have been deleted.");

        const lots = existing.inventory.lots.map((lot) => ({...lot}));
        if (vialDelta > 0) {
            if (lots.length === 0) {
                throw new Error(
                    "Add an inventory lot in Edit before increasing stock."
                );
            }
            const newest = [...lots].sort((a, b) =>
                lotDateKey(a) < lotDateKey(b) ? 1 : lotDateKey(a) > lotDateKey(b) ? -1 : 0
            )[0];
            newest.vialCount = Math.max(0, Math.trunc(newest.vialCount + vialDelta));
        } else if (vialDelta < 0) {
            let remaining = Math.abs(Math.trunc(vialDelta));
            const oldestFirst = [...lots].sort((a, b) =>
                lotDateKey(a) < lotDateKey(b) ? -1 : lotDateKey(a) > lotDateKey(b) ? 1 : 0
            );
            for (const lot of oldestFirst) {
                if (remaining <= 0) break;
                const take = Math.min(Math.max(0, lot.vialCount), remaining);
                lot.vialCount -= take;
                remaining -= take;
            }
        }

        const medication: Medication = {
            ...existing,
            inventory: {
                ...existing.inventory,
                lots,
            },
            updatedAt: nowIso(),
        };
        await db.medications.put(medication);
        return medication;
    });
}

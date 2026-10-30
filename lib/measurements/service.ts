/**
 * Body-measurements CRUD on top of Dexie. Every write is validated with the
 * canonical zod schema (defense in depth behind the form), and value shapes
 * are cross-checked against the referenced type's kind — numeric trackers
 * store numbers, blood-pressure trackers store "120/80" strings.
 *
 * Built-in trackers (Weight, Blood Pressure) are seeded idempotently by
 * `ensureBuiltinMeasurementTypes()` on every list, which covers fresh
 * databases (created straight at the latest schema version), migrated ones
 * and restored imports alike. Built-ins cannot be deleted and their kind is
 * locked; their name/unit stay editable (kg ↔ lbs).
 *
 * The caller is responsible for having run `ensureDatabase()` first (mirrors
 * `lib/scheduling/service.ts`).
 */
import {db, type MeasurementLog, type MeasurementType} from "@/lib/db";

import {BUILTIN_MEASUREMENT_TYPES, isBuiltinMeasurementType,} from "./constants";
import {effectiveKind} from "./derived";
import {
    type MeasurementLogInput,
    measurementLogInputSchema,
    measurementLogUpdateInputSchema,
    type MeasurementTypeInput,
    measurementTypeInputSchema,
} from "./schema";

function newId(): string {
    return crypto.randomUUID();
}

function nowIso(): string {
    return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Measurement types
// ---------------------------------------------------------------------------

/**
 * Inserts any missing built-in tracker (fixed ids — safe to call on every
 * boot; existing rows are left untouched).
 */
async function ensureBuiltinMeasurementTypes(): Promise<void> {
    for (const seed of BUILTIN_MEASUREMENT_TYPES) {
        const existing = await db.measurementTypes.get(seed.id);
        if (!existing) {
            await db.measurementTypes.put({
                id: seed.id,
                name: seed.name,
                unit: seed.unit,
                isCustom: false,
                valueKind: seed.valueKind,
            } satisfies MeasurementType);
        }
    }
}

/**
 * All tracker types: built-ins first in seed order, then custom ones
 * alphabetically (the type row carries no timestamps, so name is the stable
 * ordering key).
 */
export async function listMeasurementTypes(): Promise<MeasurementType[]> {
    await ensureBuiltinMeasurementTypes();
    const types = await db.measurementTypes.toArray();
    const builtinOrder = new Map(BUILTIN_MEASUREMENT_TYPES.map((s, i) => [s.id, i]));
    const rank = (type: MeasurementType) => builtinOrder.get(type.id) ?? Infinity;
    return types.sort(
        (a, b) =>
            rank(a) - rank(b) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id)
    );
}

export async function getMeasurementType(id: string): Promise<MeasurementType | undefined> {
    return db.measurementTypes.get(id);
}

/** Creates a custom tracker; rejects duplicate names (case-insensitive). */
export async function createMeasurementType(
    input: MeasurementTypeInput
): Promise<MeasurementType> {
    const parsed = measurementTypeInputSchema.parse(input);
    const existing = await listMeasurementTypes();
    if (
        existing.some(
            (type) => type.name.trim().toLowerCase() === parsed.name.toLowerCase()
        )
    ) {
        throw new Error(`A tracker named “${parsed.name}” already exists.`);
    }
    const type: MeasurementType = {
        id: newId(),
        name: parsed.name,
        unit: parsed.unit,
        isCustom: true,
        valueKind: parsed.valueKind,
    };
    await db.measurementTypes.put(type);
    return type;
}

/**
 * Updates a tracker's name/unit. Built-ins keep their fixed id, `isCustom`
 * and `valueKind` (the kind drives stored value shapes — flipping it would
 * corrupt history); custom trackers may change kind only while empty.
 */
export async function updateMeasurementType(
    id: string,
    input: MeasurementTypeInput
): Promise<MeasurementType> {
    const parsed = measurementTypeInputSchema.parse(input);
    const existing = await db.measurementTypes.get(id);
    if (!existing) throw new Error("Tracker not found — it may have been deleted.");

    const others = await db.measurementTypes
        .where("id")
        .notEqual(id)
        .toArray();
    if (
        others.some(
            (type) => type.name.trim().toLowerCase() === parsed.name.toLowerCase()
        )
    ) {
        throw new Error(`A tracker named “${parsed.name}” already exists.`);
    }

    const isBuiltin = isBuiltinMeasurementType(id) || !existing.isCustom;
    const logCount = await db.measurementLogs
        .where("measurementTypeId")
        .equals(id)
        .count();

    let valueKind = parsed.valueKind;
    if (isBuiltin) {
        valueKind = existing.valueKind ?? "numeric";
    } else if (logCount > 0 && effectiveKind(existing) !== parsed.valueKind) {
        throw new Error(
            `Can't switch kind — this tracker already has ${logCount} ` +
            `${logCount === 1 ? "reading" : "readings"}. Delete them first.`
        );
    }

    const updated: MeasurementType = {
        ...existing,
        name: parsed.name,
        unit: parsed.unit,
        valueKind,
    };
    await db.measurementTypes.put(updated);
    return updated;
}

/**
 * Deletes a custom tracker together with its readings (single transaction).
 * Built-ins refuse — they are the app's default trackers.
 */
export async function deleteMeasurementType(id: string): Promise<number> {
    if (isBuiltinMeasurementType(id)) {
        throw new Error("Built-in trackers can't be deleted.");
    }
    return db.transaction(
        "rw",
        db.measurementTypes,
        db.measurementLogs,
        async () => {
            const logs = await db.measurementLogs
                .where("measurementTypeId")
                .equals(id)
                .toArray();
            await db.measurementLogs.bulkDelete(logs.map((log) => log.id));
            await db.measurementTypes.delete(id);
            return logs.length;
        }
    );
}

// ---------------------------------------------------------------------------
// Measurement logs
// ---------------------------------------------------------------------------

/** All readings, newest first. */
export async function listMeasurementLogs(): Promise<MeasurementLog[]> {
    const logs = await db.measurementLogs.toArray();
    return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function listMeasurementLogsForType(typeId: string): Promise<MeasurementLog[]> {
    const logs = await db.measurementLogs
        .where("measurementTypeId")
        .equals(typeId)
        .toArray();
    return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getMeasurementLog(id: string): Promise<MeasurementLog | undefined> {
    return db.measurementLogs.get(id);
}

/** Stored value must agree with the referenced type's kind. */
function assertValueMatchesKind(
    type: MeasurementType,
    value: number | string
): void {
    const kind = effectiveKind(type);
    if (kind === "blood_pressure") {
        if (typeof value !== "string") {
            throw new Error(`${type.name} readings are stored as "systolic/diastolic".`);
        }
    } else if (typeof value !== "number") {
        throw new Error(`${type.name} readings must be a number.`);
    }
}

/** Records a reading for an existing tracker (timestamp defaults to now). */
export async function logMeasurement(input: MeasurementLogInput): Promise<MeasurementLog> {
    const parsed = measurementLogInputSchema.parse(input);
    const type = await db.measurementTypes.get(parsed.measurementTypeId);
    if (!type) throw new Error("Tracker not found — it may have been deleted.");
    assertValueMatchesKind(type, parsed.value);

    const log: MeasurementLog = {
        id: newId(),
        measurementTypeId: parsed.measurementTypeId,
        value: parsed.value,
        timestamp: parsed.timestamp ?? nowIso(),
        notes: parsed.notes?.trim() || undefined,
    };
    await db.measurementLogs.add(log);
    return log;
}

/** Updates a reading; the tracker may be re-selected (value re-checked). */
export async function updateMeasurementLog(
    id: string,
    input: MeasurementLogInput
): Promise<MeasurementLog> {
    const parsed = measurementLogUpdateInputSchema.parse(input);
    const existing = await db.measurementLogs.get(id);
    if (!existing) throw new Error("Reading not found — it may have been deleted.");
    const type = await db.measurementTypes.get(parsed.measurementTypeId);
    if (!type) throw new Error("Tracker not found — it may have been deleted.");
    assertValueMatchesKind(type, parsed.value);

    const log: MeasurementLog = {
        ...existing,
        measurementTypeId: parsed.measurementTypeId,
        value: parsed.value,
        timestamp: parsed.timestamp,
        notes: parsed.notes?.trim() || undefined,
    };
    await db.measurementLogs.put(log);
    return log;
}

/** Removes a single reading. Nothing else is touched. */
export async function deleteMeasurementLog(id: string): Promise<void> {
    await db.measurementLogs.delete(id);
}

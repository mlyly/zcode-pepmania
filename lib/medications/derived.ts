/**
 * Pure derived math for medications: reconstitution concentrations, dose
 * volumes, inventory status and schedule-linked stock projections. All
 * functions are total (return null / neutral values when inputs are missing)
 * so they are safe to call straight from render.
 */
import type {Medication, Schedule} from "@/lib/db/types";
import {convertUnit, formatNumber, massToMg, mgToMass, roundAmount,} from "@/lib/units";
import {scheduleCadenceLabel} from "@/lib/scheduling/occurrences";

// ---------------------------------------------------------------------------
// Reconstitution (peptides)
// ---------------------------------------------------------------------------

export interface ConcentrationInfo {
    /** Concentration in mg/mL (IU treated as 1:1 mg — check `iuFallback`). */
    mgPerMl: number;
    /** Same concentration expressed in the medication's dose unit per mL. */
    perMlInDoseUnit: number;
    /** True when the math relied on the IU 1:1 fallback. */
    iuFallback: boolean;
}

/** Resulting concentration of a reconstituted vial, in mg/mL. */
export function reconstitutionConcentration(
    medication: Pick<Medication, "reconstitution" | "unit">
): ConcentrationInfo | null {
    const recon = medication.reconstitution;
    if (!recon || recon.bacWaterAmountMl <= 0) return null;

    const vialInMg = massToMg(recon.vialQuantity, recon.vialQuantityUnit);
    const mgPerMl = vialInMg.value / recon.bacWaterAmountMl;
    if (!Number.isFinite(mgPerMl) || mgPerMl <= 0) return null;

    const iuFallback = vialInMg.iuFallback;
    if (medication.unit === "mL") {
        return {mgPerMl, perMlInDoseUnit: mgPerMl, iuFallback};
    }
    const perMl = mgToMass(mgPerMl, medication.unit);
    return {mgPerMl, perMlInDoseUnit: perMl.value, iuFallback: iuFallback || perMl.iuFallback};
}

export interface ConcentrationLabel {
    /** e.g. "2,500 mcg/mL" — expressed in the medication's dose unit. */
    primary: string;
    /** e.g. "2.5 mg/mL" — mg equivalent when the dose unit isn't mg. */
    secondary?: string;
    iuFallback: boolean;
}

/** Compact human-readable concentration for chips and meta lines. */
export function concentrationLabel(
    medication: Pick<Medication, "reconstitution" | "unit">
): ConcentrationLabel | null {
    const info = reconstitutionConcentration(medication);
    if (!info) return null;
    const primary =
        medication.unit === "mL"
            ? `${formatNumber(info.mgPerMl)} mg/mL`
            : `${formatNumber(info.perMlInDoseUnit)} ${medication.unit}/mL`;
    const secondary =
        medication.unit !== "mg" && medication.unit !== "mL"
            ? `${formatNumber(info.mgPerMl)} mg/mL`
            : undefined;
    return {primary, secondary, iuFallback: info.iuFallback};
}

/**
 * Injection volume (mL) for a dose, derived from the reconstitution:
 * volume = dose / concentration (AGENTS.md §4.3).
 */
export function doseVolumeMl(
    doseAmount: number,
    doseUnit: Medication["unit"],
    medication: Pick<Medication, "reconstitution" | "unit">
): number | null {
    if (!medication.reconstitution) return null;
    if (doseUnit === "mL") return doseAmount; // already a volume
    const concentration = reconstitutionConcentration(medication);
    if (!concentration) return null;
    const doseInMg = massToMg(doseAmount, doseUnit);
    return roundAmount(doseInMg.value / concentration.mgPerMl);
}

/** How many full doses one reconstituted vial holds (null when unknown). */
export function dosesPerVial(
    doseAmount: number,
    doseUnit: Medication["unit"],
    medication: Pick<Medication, "reconstitution">
): number | null {
    const recon = medication.reconstitution;
    if (!recon || doseAmount <= 0) return null;
    const converted = convertUnit(recon.vialQuantity, recon.vialQuantityUnit, doseUnit);
    if (!converted || converted.value <= 0) return null;
    return Math.floor(converted.value / doseAmount);
}

// ---------------------------------------------------------------------------
// Inventory tracking
// ---------------------------------------------------------------------------

export type InventoryStatus = "out" | "low" | "ok";

/** Low-stock/out classification based on `lowStockThreshold`. */
export function inventoryStatus(medication: Medication): InventoryStatus {
    const quantity = medication.inventory.currentQuantity;
    if (quantity <= 0) return "out";
    const threshold = medication.inventory.lowStockThreshold;
    if (threshold !== undefined && threshold > 0 && quantity <= threshold) return "low";
    return "ok";
}

/** 0–1 fill ratio for the stock bar (100% at threshold × 2, or at full). */
export function stockRatio(medication: Medication): number {
    const quantity = medication.inventory.currentQuantity;
    if (quantity <= 0) return 0;
    const threshold = medication.inventory.lowStockThreshold;
    const reference =
        threshold !== undefined && threshold > 0
            ? threshold * 2
            : Math.max(quantity, 1);
    return Math.min(1, quantity / reference);
}

// ---------------------------------------------------------------------------
// Schedule linkage
// ---------------------------------------------------------------------------

export function activeSchedulesFor(schedules: Schedule[], medicationId: string): Schedule[] {
    return schedules.filter((s) => s.medicationId === medicationId && s.active);
}

/**
 * Cadence label (delegates to the scheduling module so the two never drift):
 * "Daily", "Mon & Fri" (weekly days-of-week), "Every 3 days".
 */
export function scheduleFrequencyLabel(schedule: Schedule): string {
    return scheduleCadenceLabel(schedule);
}

/**
 * Total daily consumption across active schedules, expressed in the
 * medication's own unit. Returns null when a dose can't be converted
 * (e.g. an mL schedule against an mg medication).
 */
export function dailyAmountInUnit(
    medication: Medication,
    schedules: Schedule[]
): number | null {
    const active = activeSchedulesFor(schedules, medication.id);
    if (active.length === 0) return null;

    let total = 0;
    for (const schedule of active) {
        const converted = convertUnit(schedule.doseAmount, schedule.unit, medication.unit);
        if (!converted) return null;
        const perDay =
            schedule.frequencyType === "daily"
                ? 1
                : schedule.frequencyType === "weekly"
                    ? Math.max(1, schedule.weekdays?.length ?? 1) / 7
                    : schedule.intervalDays && schedule.intervalDays > 0
                        ? 1 / schedule.intervalDays
                        : null;
        if (perDay === null || perDay <= 0) return null;
        total += converted.value * perDay;
    }
    return total > 0 ? total : null;
}

/** Estimated days of stock left given active schedules (null when unknown). */
export function daysOfStockRemaining(
    medication: Medication,
    schedules: Schedule[]
): number | null {
    const daily = dailyAmountInUnit(medication, schedules);
    if (daily === null || daily <= 0) return null;
    const days = medication.inventory.currentQuantity / daily;
    return Number.isFinite(days) && days >= 0 ? days : null;
}

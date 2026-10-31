/**
 * Pure derived math for medications: reconstitution concentrations, dose
 * volumes, inventory status and schedule-linked stock projections. All
 * functions are total (return null / neutral values when inputs are missing)
 * so they are safe to call straight from render.
 */
import type {DoseUnit, InventoryLot, Medication, Schedule} from "@/lib/db/types";
import {
    type ConvertedAmount,
    convertUnit,
    formatNumber,
    isMassUnit,
    massToMg,
    mgToMass,
    roundAmount,
} from "@/lib/units";
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
    // Volume is expressed directly in mg/mL; counts have no meaningful
    // concentration, so they fall back to the same mg/mL readout.
    if (medication.unit === "mL" || medication.unit === "pcs") {
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
        medication.unit === "mL" || medication.unit === "pcs"
            ? `${formatNumber(info.mgPerMl)} mg/mL`
            : `${formatNumber(info.perMlInDoseUnit)} ${medication.unit}/mL`;
    const secondary =
        medication.unit !== "mg" && medication.unit !== "mL" && medication.unit !== "pcs"
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
    if (doseUnit === "pcs") return null; // counts have no injection volume
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

/** Amount in one lot (vials × content per vial), before unit conversion. */
export function lotTotalAmount(lot: InventoryLot): number {
    return roundAmount(lot.vialCount * lot.contentAmount);
}

/** Value of one lot (vials × price per container); null when unpriced. */
export function lotTotalPrice(lot: InventoryLot): number | null {
    if (lot.pricePerContainer === undefined) return null;
    return roundAmount(lot.vialCount * lot.pricePerContainer);
}

export interface InventoryPriceTotals {
    /** Sum of every priced lot, in USD. */
    totalPrice: number;
    /** Lots that carry a price. */
    pricedLots: number;
    /** Lots without a price (excluded from the total). */
    unpricedLots: number;
}

/** Sums the value of every priced lot in a medication's inventory. */
export function inventoryPriceTotals(medication: Medication): InventoryPriceTotals {
    let totalPrice = 0;
    let pricedLots = 0;

    for (const lot of medication.inventory.lots) {
        if (lot.pricePerContainer === undefined) continue;
        pricedLots += 1;
        totalPrice += lot.vialCount * lot.pricePerContainer;
    }

    return {
        totalPrice: roundAmount(totalPrice),
        pricedLots,
        unpricedLots: medication.inventory.lots.length - pricedLots,
    };
}

/**
 * Converts an amount into the medication's display unit. Direct unit
 * conversion is tried first; mass ↔ volume falls back to the reconstitution
 * concentration when one is available. Returns null when no path exists
 * (e.g. pieces against a mass unit).
 */
export function amountInMedicationUnit(
    amount: number,
    unit: DoseUnit,
    medication: Pick<Medication, "reconstitution" | "unit">
): ConvertedAmount | null {
    if (!Number.isFinite(amount)) return null;
    if (unit === medication.unit) return {value: amount, iuFallback: false};

    const direct = convertUnit(amount, unit, medication.unit);
    if (direct) return direct;

    const concentration = reconstitutionConcentration(medication);
    if (!concentration || concentration.mgPerMl <= 0) return null;

    if (unit === "mL" && isMassUnit(medication.unit)) {
        const converted = mgToMass(amount * concentration.mgPerMl, medication.unit);
        return {
            value: converted.value,
            iuFallback: concentration.iuFallback || converted.iuFallback,
        };
    }
    if (isMassUnit(unit) && medication.unit === "mL") {
        const converted = massToMg(amount, unit);
        return {
            value: converted.value / concentration.mgPerMl,
            iuFallback: converted.iuFallback || concentration.iuFallback,
        };
    }
    return null;
}

export interface InventoryTotals {
    /** Total stock on hand, expressed in the medication's unit. */
    quantity: number;
    /** Containers across every lot. */
    vialCount: number;
    lotCount: number;
    /** Lots with content that couldn't be expressed in the medication's unit. */
    unconvertibleLots: number;
    /** True when any included amount used the IU 1:1 fallback. */
    iuFallback: boolean;
}

/** Sums every inventory lot into the medication's display unit. */
export function inventoryTotals(medication: Medication): InventoryTotals {
    let quantity = 0;
    let vialCount = 0;
    let unconvertibleLots = 0;
    let iuFallback = false;

    for (const lot of medication.inventory.lots) {
        vialCount += lot.vialCount;
        const amount = lotTotalAmount(lot);
        if (amount <= 0) continue;
        const converted = amountInMedicationUnit(amount, lot.contentUnit, medication);
        if (!converted) {
            unconvertibleLots += 1;
            continue;
        }
        quantity += converted.value;
        iuFallback = iuFallback || converted.iuFallback;
    }

    return {
        quantity: roundAmount(quantity),
        vialCount,
        lotCount: medication.inventory.lots.length,
        unconvertibleLots,
        iuFallback,
    };
}

/** Convenience: total stock on hand in the medication's unit. */
export function inventoryQuantity(medication: Medication): number {
    return inventoryTotals(medication).quantity;
}

/** Low-stock/out classification based on `lowStockThreshold`. */
export function inventoryStatus(medication: Medication): InventoryStatus {
    const quantity = inventoryQuantity(medication);
    if (quantity <= 0) return "out";
    const threshold = medication.inventory.lowStockThreshold;
    if (threshold !== undefined && threshold > 0 && quantity <= threshold) return "low";
    return "ok";
}

/** 0–1 fill ratio for the stock bar (100% at threshold × 2, or at full). */
export function stockRatio(medication: Medication): number {
    const quantity = inventoryQuantity(medication);
    if (quantity <= 0) return 0;
    const threshold = medication.inventory.lowStockThreshold;
    const reference =
        threshold !== undefined && threshold > 0
            ? threshold * 2
            : Math.max(quantity, 1);
    return Math.min(1, quantity / reference);
}

/**
 * Human-readable stock runway: days under two months, months under two
 * years, years beyond that. `null` in → `null` out.
 */
export function formatStockDuration(days: number | null): string | null {
    if (days === null || !Number.isFinite(days) || days < 0) return null;
    if (days < 1) return "< 1 day";
    if (days < 60) {
        const whole = Math.max(1, Math.round(days));
        return `${whole} ${whole === 1 ? "day" : "days"}`;
    }
    if (days < 730) {
        let months = Math.max(1, Math.floor(days / 30.4375));
        let remainder = Math.round(days - months * 30.4375);
        // Never render a "1 mo 30 d" style remainder.
        if (remainder >= 30) {
            months += 1;
            remainder = 0;
        }
        return remainder > 0 ? `${months} mo ${remainder} d` : `${months} mo`;
    }
    let years = Math.max(1, Math.floor(days / 365.25));
    let months = Math.round((days - years * 365.25) / 30.4375);
    if (months >= 12) {
        years += 1;
        months = 0;
    }
    return months > 0 ? `${years} yr ${months} mo` : `${years} yr`;
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
        const converted = amountInMedicationUnit(
            schedule.doseAmount,
            schedule.unit,
            medication
        );
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
    const days = inventoryQuantity(medication) / daily;
    return Number.isFinite(days) && days >= 0 ? days : null;
}

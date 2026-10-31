/**
 * Unit conversion & formatting helpers (AGENTS.md §4.1).
 *
 * Mass amounts are standardized to a mg base for all math; `mcg` converts
 * exactly, `mL` is a volume unit that only converts through a reconstitution
 * concentration, and `IU` has no universal ratio — it falls back to a 1:1
 * mapping with mg and flags the result so the UI can surface a warning.
 */
import type {DoseUnit, MassUnit} from "./db/types";

/** U-100 syringes: 1 mL = 100 units. */
export const UNITS_PER_ML = 100;

/** Shown wherever a value relies on the IU 1:1 fallback. */
export const IU_FALLBACK_WARNING =
    "IU has no fixed mass ratio — values are treated 1 IU = 1 mg for math. Verify your product's IU-per-mg if precision matters.";

export interface ConvertedAmount {
    value: number;
    /** True when the conversion relied on the IU 1:1 fallback. */
    iuFallback: boolean;
}

/** Converts a mass amount to milligrams. */
export function massToMg(amount: number, unit: MassUnit): ConvertedAmount {
    switch (unit) {
        case "mg":
            return {value: amount, iuFallback: false};
        case "mcg":
            return {value: amount / 1000, iuFallback: false};
        case "IU":
            return {value: amount, iuFallback: true};
    }
}

/** Converts milligrams to the given mass unit. */
export function mgToMass(amountMg: number, unit: MassUnit): ConvertedAmount {
    switch (unit) {
        case "mg":
            return {value: amountMg, iuFallback: false};
        case "mcg":
            return {value: amountMg * 1000, iuFallback: false};
        case "IU":
            return {value: amountMg, iuFallback: true};
    }
}

export function isMassUnit(unit: DoseUnit): unit is MassUnit {
    return unit === "mg" || unit === "mcg" || unit === "IU";
}

/**
 * Converts between dose units. Returns `null` when no exact conversion
 * exists: volumes require a reconstitution concentration and counts only
 * convert to counts.
 */
export function convertUnit(
    amount: number,
    from: DoseUnit,
    to: DoseUnit
): ConvertedAmount | null {
    if (from === to) return {value: amount, iuFallback: false};
    if (from === "mL" || to === "mL") return null;
    if (from === "pcs" || to === "pcs") return null;
    const inMg = massToMg(amount, from);
    const out = mgToMass(inMg.value, to);
    return {value: out.value, iuFallback: inMg.iuFallback || out.iuFallback};
}

/** Converts a volume in mL to marks on a U-100 syringe. */
export function mlToSyringeUnits(ml: number): number {
    return ml * UNITS_PER_ML;
}

/**
 * Syringe marks as drawn on a U-100 syringe: whole units, rounded up (a
 * partial mark is drawn by advancing to the next tick). Float noise is
 * trimmed first so e.g. 0.07 mL shows 7 U, not 8 U.
 */
export function mlToWholeSyringeUnits(ml: number): number {
    return Math.ceil(roundAmount(mlToSyringeUnits(ml)));
}

/** Trims float noise (e.g. 0.30000000000000004) for storage/display. */
export function roundAmount(value: number, fractionDigits = 6): number {
    const factor = 10 ** fractionDigits;
    return Math.round(value * factor) / factor;
}

/**
 * Parses a user-entered decimal number. Accepts both "." and "," as the
 * decimal separator (e.g. "2,5" → 2.5), so locale keyboards work as-is.
 * Returns `undefined` for blank or non-numeric input.
 */
export function parseDecimalInput(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    // Treat commas as decimal separators instead of rejecting the entry.
    const value = Number(trimmed.replace(/,/g, "."));
    return Number.isFinite(value) ? value : undefined;
}

const amountFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 3,
});

/** Compact numeric formatting with grouping and trimmed trailing zeros. */
export function formatNumber(value: number): string {
    return amountFormatter.format(value);
}

/** Formats an amount with its unit, e.g. `2,500 mcg` or `0.1 mL`. */
export function formatAmount(value: number, unit: string): string {
    return `${formatNumber(value)} ${unit}`;
}

const priceFormatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
});

/** Formats a USD price, e.g. `$12.50`. */
export function formatPrice(value: number): string {
    return priceFormatter.format(value);
}

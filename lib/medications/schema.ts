/**
 * Zod schemas for the medication module.
 *
 * `medicationInputSchema` is the canonical, service-level contract (numbers,
 * already trimmed). `medicationFormSchema` mirrors the add/edit dialog where
 * every numeric field is a raw string input; numeric rules are enforced in a
 * single `superRefine` pass so messages stay human-readable, and
 * `toMedicationInput` turns validated strings into the canonical input.
 *
 * Stock is never typed in directly: callers provide the number of containers
 * and the amount per container, and the service derives
 * `inventory.currentQuantity = vialCount × containerSize`.
 */
import {z} from "zod";

import type {Medication} from "@/lib/db/types";
import {convertUnit, isMassUnit, parseDecimalInput, roundAmount} from "@/lib/units";
import {DOSE_UNITS, MASS_UNITS, MEDICATION_TYPES} from "./constants";

// ---------------------------------------------------------------------------
// Canonical (service-level) schema
// ---------------------------------------------------------------------------

export const medicationInputSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Name is required")
        .max(80, "Keep the name under 80 characters"),
    type: z.enum(MEDICATION_TYPES),
    unit: z.enum(DOSE_UNITS),
    halfLifeHours: z
        .number()
        .positive("Half-life must be greater than zero")
        .max(100000, "Half-life looks too large")
        .optional(),
    inventory: z.object({
        vialCount: z
            .number()
            .int("Containers must be a whole number")
            .min(0, "Containers can't be negative"),
        /** Amount per container — stock is derived from count × this. */
        containerSize: z
            .number()
            .positive("Container size must be greater than zero"),
        lowStockThreshold: z
            .number()
            .min(0, "Threshold can't be negative")
            .optional(),
    }),
    reconstitution: z
        .object({
            vialQuantity: z.number().positive("Vial quantity must be greater than zero"),
            vialQuantityUnit: z.enum(MASS_UNITS),
            bacWaterAmountMl: z
                .number()
                .positive("BAC water must be greater than zero"),
        })
        .optional(),
    notes: z
        .string()
        .trim()
        .max(2000, "Notes are limited to 2000 characters")
        .optional(),
});

export type MedicationInput = z.infer<typeof medicationInputSchema>;

// ---------------------------------------------------------------------------
// Form (dialog) schema
// ---------------------------------------------------------------------------

export const medicationFormSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(1, "Name is required")
            .max(80, "Keep the name under 80 characters"),
        type: z.enum(MEDICATION_TYPES),
        unit: z.enum(DOSE_UNITS),
        // Optional numeric inputs — "" means "not set"; validated in superRefine.
        halfLifeHours: z.string(),
        vialCount: z.string(),
        containerSize: z.string(),
        lowStockThreshold: z.string(),
        hasReconstitution: z.boolean(),
        vialQuantity: z.string(),
        vialQuantityUnit: z.enum(MASS_UNITS),
        bacWaterAmountMl: z.string(),
        notes: z.string().max(2000, "Notes are limited to 2000 characters"),
    })
    .superRefine((values, ctx) => {
        const reconstituted = values.type === "peptide" && values.hasReconstitution;
        // mL-dosed peptides size each vial by its BAC-water volume, so the
        // per-container amount is derived and the vial mass is typed below.
        const vialSizedByWater = reconstituted && values.unit === "mL";
        checkNumeric(ctx, "vialCount", values.vialCount, {
            label: "Containers",
            required: true,
            integer: true,
            min: 0,
        });
        if (!vialSizedByWater) {
            checkNumeric(ctx, "containerSize", values.containerSize, {
                label: "Container size",
                required: true,
                positive: true,
            });
        }
        checkNumeric(ctx, "lowStockThreshold", values.lowStockThreshold, {
            label: "Low-stock threshold",
            min: 0,
        });
        checkNumeric(ctx, "halfLifeHours", values.halfLifeHours, {
            label: "Half-life",
            positive: true,
            max: 100000,
        });
        if (reconstituted) {
            checkNumeric(ctx, "bacWaterAmountMl", values.bacWaterAmountMl, {
                label: "BAC water",
                required: true,
                positive: true,
            });
            if (vialSizedByWater) {
                checkNumeric(ctx, "vialQuantity", values.vialQuantity, {
                    label: "Vial quantity",
                    required: true,
                    positive: true,
                });
            }
        }
    });

export type MedicationFormValues = z.infer<typeof medicationFormSchema>;

interface NumericRules {
    label: string;
    /** Missing values are an error when true, ignored otherwise. */
    required?: boolean;
    min?: number;
    max?: number;
    positive?: boolean;
    integer?: boolean;
}

type RefineContext = {
    addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void;
};

function checkNumeric(
    ctx: RefineContext,
    path: string,
    raw: string,
    rules: NumericRules
): void {
    const trimmed = raw.trim();
    if (trimmed === "") {
        if (rules.required) {
            ctx.addIssue({code: "custom", path: [path], message: `${rules.label} is required`});
        }
        return;
    }
    const value = parseDecimalInput(trimmed);
    if (value === undefined) {
        ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${rules.label} must be a number`,
        });
        return;
    }
    if (rules.positive && value <= 0) {
        ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${rules.label} must be greater than zero`,
        });
        return;
    }
    if (rules.min !== undefined && value < rules.min) {
        ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${rules.label} can't be below ${rules.min}`,
        });
        return;
    }
    if (rules.max !== undefined && value > rules.max) {
        ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${rules.label} looks too large`,
        });
        return;
    }
    if (rules.integer && !Number.isInteger(value)) {
        ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${rules.label} must be a whole number`,
        });
    }
}

// ---------------------------------------------------------------------------
// Conversions between form values and the canonical input
// ---------------------------------------------------------------------------

/** Parses a validated form string into a number (`""` → undefined). */
function parseFormNumber(raw: string): number | undefined {
    return parseDecimalInput(raw);
}

/**
 * Best-effort prefill for the per-container amount on rows saved before the
 * stock field was removed: prefer the stored size, else a value that keeps
 * the stored total intact, else the reconstitution vial mass converted into
 * the medication's unit.
 */
function prefillContainerSize(medication: Medication): string {
    const {currentQuantity, vialCount, containerSize} = medication.inventory;
    if (containerSize !== undefined && containerSize > 0) {
        return containerSize.toString();
    }
    if (vialCount > 0 && currentQuantity > 0) {
        return roundAmount(currentQuantity / vialCount).toString();
    }
    const recon = medication.reconstitution;
    if (recon && isMassUnit(medication.unit)) {
        const converted = convertUnit(
            recon.vialQuantity,
            recon.vialQuantityUnit,
            medication.unit
        );
        if (converted && converted.value > 0) return roundAmount(converted.value).toString();
    }
    return "";
}

/** Builds dialog defaults; pass a medication to prefill for editing. */
export function medicationToFormValues(medication?: Medication): MedicationFormValues {
    if (!medication) {
        return {
            name: "",
            type: "peptide",
            unit: "mg",
            halfLifeHours: "",
            vialCount: "0",
            containerSize: "",
            lowStockThreshold: "",
            hasReconstitution: false,
            vialQuantity: "",
            vialQuantityUnit: "mg",
            bacWaterAmountMl: "",
            notes: "",
        };
    }
    return {
        name: medication.name,
        type: medication.type,
        unit: medication.unit,
        halfLifeHours: medication.halfLifeHours?.toString() ?? "",
        vialCount: medication.inventory.vialCount.toString(),
        containerSize: prefillContainerSize(medication),
        lowStockThreshold: medication.inventory.lowStockThreshold?.toString() ?? "",
        hasReconstitution: medication.type === "peptide" && !!medication.reconstitution,
        vialQuantity: medication.reconstitution?.vialQuantity.toString() ?? "",
        vialQuantityUnit: medication.reconstitution?.vialQuantityUnit ?? "mg",
        bacWaterAmountMl: medication.reconstitution?.bacWaterAmountMl.toString() ?? "",
        notes: medication.notes ?? "",
    };
}

/** Converts validated form values into the canonical service input. */
export function toMedicationInput(values: MedicationFormValues): MedicationInput {
    // Optional keys are always present (possibly undefined) so the service's
    // PUT semantics can clear them when a user removes the value.
    const input: MedicationInput = {
        name: values.name.trim(),
        type: values.type,
        unit: values.unit,
        halfLifeHours: parseFormNumber(values.halfLifeHours),
        inventory: {
            vialCount: Math.trunc(parseFormNumber(values.vialCount) ?? 0),
            containerSize: parseFormNumber(values.containerSize) ?? Number.NaN,
            lowStockThreshold: parseFormNumber(values.lowStockThreshold),
        },
        notes: values.notes.trim() || undefined,
        // Reconstitution is a peptide-only feature; other types drop it.
        reconstitution: undefined,
    };
    if (values.type === "peptide" && values.hasReconstitution) {
        const bacWaterAmountMl = parseFormNumber(values.bacWaterAmountMl) ?? Number.NaN;
        if (values.unit === "mL") {
            // Volume-dosed peptide: the vial mass is typed in the dialog's
            // reconstitution fields, and each vial's stock volume is the BAC
            // water mixed into it.
            input.reconstitution = {
                vialQuantity: parseFormNumber(values.vialQuantity) ?? Number.NaN,
                vialQuantityUnit: values.vialQuantityUnit,
                bacWaterAmountMl,
            };
            input.inventory.containerSize = bacWaterAmountMl;
        } else {
            // Mass-dosed peptide: the per-container inventory amount IS the
            // peptide mass per vial — no second field to retype.
            input.reconstitution = {
                vialQuantity: parseFormNumber(values.containerSize) ?? Number.NaN,
                vialQuantityUnit: values.unit,
                bacWaterAmountMl,
            };
        }
    }
    return input;
}

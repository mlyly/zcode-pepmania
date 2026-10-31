/**
 * Zod schemas for the medication module.
 *
 * `medicationInputSchema` is the canonical, service-level contract (numbers,
 * already trimmed). `medicationFormSchema` mirrors the add/edit dialog where
 * every numeric field is a raw string input; numeric rules are enforced in a
 * single `superRefine` pass so messages stay human-readable, and
 * `toMedicationInput` turns validated strings into the canonical input.
 *
 * Inventory is a list of lots. Each lot stores the number of containers and
 * the content of one container (e.g. `3 × 5 mg`), plus order/delivery dates,
 * vendor, COA links and notes. Totals are never typed in directly — the
 * derived helpers sum the lots when the UI needs a stock figure.
 */
import {z} from "zod";

import type {DoseUnit, Medication} from "@/lib/db/types";
import {parseDecimalInput} from "@/lib/units";
import {DOSE_UNITS, MASS_UNITS, MEDICATION_TYPES} from "./constants";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real local calendar date (rejects 2026-02-30). */
function isRealDate(value: string): boolean {
    const match = DATE_ONLY_PATTERN.exec(value.trim());
    if (!match) return false;
    const [year, month, day] = value.trim().split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    );
}

const optionalDateSchema = z
    .string()
    .trim()
    .refine((value) => value === "" || isRealDate(value), "Use a real date (YYYY-MM-DD)")
    .optional();

/**
 * Normalizes a pasted COA link. Bare hostnames get `https://`; only http(s)
 * URLs are accepted (never `javascript:`, `data:` etc.).
 */
export function normalizeCoaUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (!url.hostname) return null;
        return url.toString();
    } catch {
        return null;
    }
}

/** Splits a textarea of COA links (one per line or comma-separated). */
export function parseCoaUrls(raw: string): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const token of raw.split(/[\n,]+/)) {
        const normalized = normalizeCoaUrl(token);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        urls.push(normalized);
    }
    return urls;
}

function isValidHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.hostname.length > 0
        );
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Canonical (service-level) schema
// ---------------------------------------------------------------------------

export const inventoryLotInputSchema = z.object({
    /** Preserved when editing; omitted for new rows (the service assigns one). */
    id: z.string().trim().min(1).optional(),
    vialCount: z
        .number()
        .int("Containers must be a whole number")
        .min(0, "Containers can't be negative"),
    /** Amount in one container (e.g. 5 mg, 60 pcs). */
    contentAmount: z.number().positive("Container content must be greater than zero"),
    contentUnit: z.enum(DOSE_UNITS),
    orderDate: optionalDateSchema,
    deliveryDate: optionalDateSchema,
    vendor: z.string().trim().max(200, "Vendor is limited to 200 characters").optional(),
    /** Price paid per container/vial, in USD. */
    pricePerContainer: z
        .number()
        .min(0, "Price can't be negative")
        .max(1000000, "Price looks too large")
        .optional(),
    coaUrls: z
        .array(
            z
                .string()
                .trim()
                .max(2048, "COA links are limited to 2048 characters")
                .refine(isValidHttpUrl, "Use an http(s) link")
        )
        .max(20, "Keep it to 20 COA links")
        .optional(),
    notes: z.string().trim().max(1000, "Lot notes are limited to 1000 characters").optional(),
});

export type InventoryLotInput = z.infer<typeof inventoryLotInputSchema>;

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
        lots: z.array(inventoryLotInputSchema).max(50, "Keep it to 50 inventory lots"),
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

export const inventoryLotFormSchema = z.object({
    id: z.string(),
    vialCount: z.string(),
    contentAmount: z.string(),
    contentUnit: z.enum(DOSE_UNITS),
    orderDate: z.string(),
    deliveryDate: z.string(),
    vendor: z.string().max(200, "Vendor is limited to 200 characters"),
    pricePerContainer: z.string(),
    coaUrlsText: z.string().max(5000, "COA links are too long"),
    notes: z.string().max(1000, "Lot notes are limited to 1000 characters"),
});

export type InventoryLotFormValues = z.infer<typeof inventoryLotFormSchema>;

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
        inventoryLots: z.array(inventoryLotFormSchema).max(50, "Keep it to 50 inventory lots"),
        lowStockThreshold: z.string(),
        hasReconstitution: z.boolean(),
        vialQuantity: z.string(),
        vialQuantityUnit: z.enum(MASS_UNITS),
        bacWaterAmountMl: z.string(),
        notes: z.string().max(2000, "Notes are limited to 2000 characters"),
    })
    .superRefine((values, ctx) => {
        values.inventoryLots.forEach((lot, index) => {
            const base = ["inventoryLots", index] as const;
            checkNumeric(ctx, [...base, "vialCount"], lot.vialCount, {
                label: `Lot ${index + 1} containers`,
                required: true,
                integer: true,
                min: 0,
            });
            checkNumeric(ctx, [...base, "contentAmount"], lot.contentAmount, {
                label: `Lot ${index + 1} container content`,
                required: true,
                positive: true,
            });
            checkNumeric(ctx, [...base, "pricePerContainer"], lot.pricePerContainer, {
                label: `Lot ${index + 1} price per container`,
                min: 0,
                max: 1000000,
            });
            checkDate(ctx, [...base, "orderDate"], lot.orderDate, `Lot ${index + 1} order date`);
            checkDate(
                ctx,
                [...base, "deliveryDate"],
                lot.deliveryDate,
                `Lot ${index + 1} delivery date`
            );

            if (
                isRealDate(lot.orderDate.trim()) &&
                isRealDate(lot.deliveryDate.trim()) &&
                lot.deliveryDate.trim() < lot.orderDate.trim()
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: [...base, "deliveryDate"],
                    message: "Delivery can't be before the order date",
                });
            }

            for (const token of lot.coaUrlsText.split(/[\n,]+/)) {
                if (token.trim() === "") continue;
                if (!normalizeCoaUrl(token)) {
                    ctx.addIssue({
                        code: "custom",
                        path: [...base, "coaUrlsText"],
                        message: `"${token.trim()}" is not a valid http(s) link`,
                    });
                    break;
                }
            }
        });

        checkNumeric(ctx, ["lowStockThreshold"], values.lowStockThreshold, {
            label: "Low-stock threshold",
            min: 0,
        });
        checkNumeric(ctx, ["halfLifeHours"], values.halfLifeHours, {
            label: "Half-life",
            positive: true,
            max: 100000,
        });
        if (values.type === "peptide" && values.hasReconstitution) {
            checkNumeric(ctx, ["bacWaterAmountMl"], values.bacWaterAmountMl, {
                label: "BAC water",
                required: true,
                positive: true,
            });
            checkNumeric(ctx, ["vialQuantity"], values.vialQuantity, {
                label: "Peptide per vial",
                required: true,
                positive: true,
            });
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
    addIssue: (issue: {
        code: "custom";
        path: (string | number)[];
        message: string;
    }) => void;
};

function checkNumeric(
    ctx: RefineContext,
    path: (string | number)[],
    raw: string,
    rules: NumericRules
): void {
    const trimmed = raw.trim();
    if (trimmed === "") {
        if (rules.required) {
            ctx.addIssue({code: "custom", path, message: `${rules.label} is required`});
        }
        return;
    }
    const value = parseDecimalInput(trimmed);
    if (value === undefined) {
        ctx.addIssue({
            code: "custom",
            path,
            message: `${rules.label} must be a number`,
        });
        return;
    }
    if (rules.positive && value <= 0) {
        ctx.addIssue({
            code: "custom",
            path,
            message: `${rules.label} must be greater than zero`,
        });
        return;
    }
    if (rules.min !== undefined && value < rules.min) {
        ctx.addIssue({
            code: "custom",
            path,
            message: `${rules.label} can't be below ${rules.min}`,
        });
        return;
    }
    if (rules.max !== undefined && value > rules.max) {
        ctx.addIssue({
            code: "custom",
            path,
            message: `${rules.label} looks too large`,
        });
        return;
    }
    if (rules.integer && !Number.isInteger(value)) {
        ctx.addIssue({
            code: "custom",
            path,
            message: `${rules.label} must be a whole number`,
        });
    }
}

function checkDate(
    ctx: RefineContext,
    path: (string | number)[],
    raw: string,
    label: string
): void {
    const trimmed = raw.trim();
    if (trimmed === "" || isRealDate(trimmed)) return;
    ctx.addIssue({code: "custom", path, message: `${label} must be a real date`});
}

// ---------------------------------------------------------------------------
// Conversions between form values and the canonical input
// ---------------------------------------------------------------------------

/** Parses a validated form string into a number (`""` → undefined). */
function parseFormNumber(raw: string): number | undefined {
    return parseDecimalInput(raw);
}

/** Creates a blank lot row for the dialog. */
export function newInventoryLotFormValues(
    contentUnit: DoseUnit = "mg"
): InventoryLotFormValues {
    return {
        id: crypto.randomUUID(),
        vialCount: "0",
        contentAmount: "",
        contentUnit,
        orderDate: "",
        deliveryDate: "",
        vendor: "",
        pricePerContainer: "",
        coaUrlsText: "",
        notes: "",
    };
}

/** Builds dialog defaults; pass a medication to prefill for editing. */
export function medicationToFormValues(medication?: Medication): MedicationFormValues {
    if (!medication) {
        return {
            name: "",
            type: "peptide",
            unit: "mg",
            halfLifeHours: "",
            inventoryLots: [newInventoryLotFormValues("mg")],
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
        inventoryLots: medication.inventory.lots.map((lot) => ({
            id: lot.id,
            vialCount: lot.vialCount.toString(),
            contentAmount: lot.contentAmount.toString(),
            contentUnit: lot.contentUnit,
            orderDate: lot.orderDate ?? "",
            deliveryDate: lot.deliveryDate ?? "",
            vendor: lot.vendor ?? "",
            pricePerContainer: lot.pricePerContainer?.toString() ?? "",
            coaUrlsText: lot.coaUrls?.join("\n") ?? "",
            notes: lot.notes ?? "",
        })),
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
            lots: values.inventoryLots.map((lot) => {
                const coaUrls = parseCoaUrls(lot.coaUrlsText);
                return {
                    id: lot.id.trim() || undefined,
                    vialCount: Math.trunc(parseFormNumber(lot.vialCount) ?? 0),
                    contentAmount: parseFormNumber(lot.contentAmount) ?? Number.NaN,
                    contentUnit: lot.contentUnit,
                    orderDate: lot.orderDate.trim() || undefined,
                    deliveryDate: lot.deliveryDate.trim() || undefined,
                    vendor: lot.vendor.trim() || undefined,
                    pricePerContainer: parseFormNumber(lot.pricePerContainer),
                    coaUrls: coaUrls.length > 0 ? coaUrls : undefined,
                    notes: lot.notes.trim() || undefined,
                };
            }),
            lowStockThreshold: parseFormNumber(values.lowStockThreshold),
        },
        notes: values.notes.trim() || undefined,
        // Reconstitution is a peptide-only feature; other types drop it.
        reconstitution: undefined,
    };
    if (values.type === "peptide" && values.hasReconstitution) {
        input.reconstitution = {
            vialQuantity: parseFormNumber(values.vialQuantity) ?? Number.NaN,
            vialQuantityUnit: values.vialQuantityUnit,
            bacWaterAmountMl: parseFormNumber(values.bacWaterAmountMl) ?? Number.NaN,
        };
    }
    return input;
}

/**
 * Zod schemas for the body-measurements module.
 *
 * Same split as the scheduling/dose-log modules: canonical service-level
 * contracts (`measurementTypeInputSchema`, `measurementLogInputSchema`)
 * enforce the storage shape, while the `*FormSchema` variants mirror the
 * dialogs where numbers arrive as raw strings; `to*Input` conversions bridge
 * validated form values into the canonical inputs.
 */
import {z} from "zod";

import type {MeasurementLog, MeasurementType, MeasurementValueKind} from "@/lib/db/types";
import {DATETIME_LOCAL_PATTERN, datetimeLocalToIso, isoToDatetimeLocal} from "@/lib/scheduling/dates";
import {
    BLOOD_PRESSURE_PATTERN,
    DIASTOLIC_RANGE,
    MAX_MEASUREMENT_VALUE,
    MAX_NOTES_LENGTH,
    MAX_TYPE_NAME_LENGTH,
    MAX_UNIT_LENGTH,
    MEASUREMENT_VALUE_KINDS,
    SYSTOLIC_RANGE,
} from "./constants";
import {type BloodPressureValue, toStoredValue} from "./derived";

// ---------------------------------------------------------------------------
// Canonical (service-level) schemas
// ---------------------------------------------------------------------------

export const measurementValueKindSchema = z.enum(MEASUREMENT_VALUE_KINDS);

export const measurementTypeInputSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Name is required")
        .max(MAX_TYPE_NAME_LENGTH, `Keep the name under ${MAX_TYPE_NAME_LENGTH} characters`),
    unit: z
        .string()
        .trim()
        .min(1, "Unit is required")
        .max(MAX_UNIT_LENGTH, `Keep the unit under ${MAX_UNIT_LENGTH} characters`),
    valueKind: measurementValueKindSchema,
});

export type MeasurementTypeInput = z.infer<typeof measurementTypeInputSchema>;

/** Stored BP string ("120/80") with real-world bounds, systolic > diastolic. */
export const bloodPressureValueSchema = z
    .string()
    .regex(BLOOD_PRESSURE_PATTERN, 'Use "systolic/diastolic", e.g. 120/80')
    .refine((value) => {
        const match = BLOOD_PRESSURE_PATTERN.exec(value);
        if (!match) return false;
        const systolic = Number(match[1]);
        const diastolic = Number(match[2]);
        return (
            systolic >= SYSTOLIC_RANGE[0] &&
            systolic <= SYSTOLIC_RANGE[1] &&
            diastolic >= DIASTOLIC_RANGE[0] &&
            diastolic <= DIASTOLIC_RANGE[1] &&
            systolic > diastolic
        );
    }, "Check the numbers — systolic must exceed diastolic");

/**
 * A stored measurement value: positive number for numeric trackers, BP
 * string for blood-pressure trackers. Kind agreement with the referenced
 * type is enforced by the service (which knows the type).
 */
export const measurementValueSchema = z.union([
    z
        .number()
        .positive("Value must be greater than zero")
        .max(MAX_MEASUREMENT_VALUE, "Value looks too large"),
    bloodPressureValueSchema,
]);

export const measurementLogInputSchema = z.object({
    measurementTypeId: z.string().min(1, "Choose a tracker"),
    value: measurementValueSchema,
    /** ISO instant of the reading (defaults to now on create). */
    timestamp: z.string().min(1).optional(),
    notes: z
        .string()
        .trim()
        .max(MAX_NOTES_LENGTH, `Notes are limited to ${MAX_NOTES_LENGTH} characters`)
        .optional(),
});

export type MeasurementLogInput = z.infer<typeof measurementLogInputSchema>;

/**
 * PUT-style update contract — the timestamp is required so every edit
 * re-stamps from the form (mirrors `doseLogUpdateInputSchema`).
 */
export interface MeasurementLogUpdateInput {
    measurementTypeId: string;
    value: number | string;
    timestamp: string;
    /** PUT semantics: an absent optional field clears the stored value. */
    notes?: string;
}

export const measurementLogUpdateInputSchema = z.object({
    measurementTypeId: z.string().min(1, "Choose a tracker"),
    value: measurementValueSchema,
    /** New reading instant (ISO) — required, an edit restamps from the form. */
    timestamp: z
        .string()
        .min(1, "Pick a date and time")
        .refine((value) => !Number.isNaN(new Date(value).getTime()), "Not a valid date"),
    notes: measurementLogInputSchema.shape.notes,
});

// ---------------------------------------------------------------------------
// Type form (dialog)
// ---------------------------------------------------------------------------

export const measurementTypeFormSchema = z
    .object({
        name: z.string().trim(),
        unit: z.string().trim(),
        valueKind: measurementValueKindSchema,
    })
    .superRefine((values, ctx) => {
        if (values.name === "") {
            ctx.addIssue({code: "custom", path: ["name"], message: "Name is required"});
        } else if (values.name.length > MAX_TYPE_NAME_LENGTH) {
            ctx.addIssue({
                code: "custom",
                path: ["name"],
                message: `Keep the name under ${MAX_TYPE_NAME_LENGTH} characters`,
            });
        }
        if (values.unit === "") {
            ctx.addIssue({code: "custom", path: ["unit"], message: "Unit is required"});
        } else if (values.unit.length > MAX_UNIT_LENGTH) {
            ctx.addIssue({
                code: "custom",
                path: ["unit"],
                message: `Keep the unit under ${MAX_UNIT_LENGTH} characters`,
            });
        }
    });

export type MeasurementTypeFormValues = z.infer<typeof measurementTypeFormSchema>;

export function measurementTypeToFormValues(
    type?: MeasurementType | null
): MeasurementTypeFormValues {
    return {
        name: type?.name ?? "",
        unit: type?.unit ?? "",
        valueKind: type?.valueKind ?? "numeric",
    };
}

export function toMeasurementTypeInput(values: MeasurementTypeFormValues): MeasurementTypeInput {
    return measurementTypeInputSchema.parse(values);
}

// ---------------------------------------------------------------------------
// Log form (dialog)
// ---------------------------------------------------------------------------

export const measurementLogFormSchema = z
    .object({
        measurementTypeId: z.string().min(1, "Choose a tracker"),
        /** Mirrors the selected type's kind — drives which fields are required. */
        valueKind: measurementValueKindSchema,
        numericValue: z.string(),
        systolic: z.string(),
        diastolic: z.string(),
        /** `datetime-local` value: `YYYY-MM-DDTHH:MM`, seconds optional. */
        timestamp: z
            .string()
            .regex(DATETIME_LOCAL_PATTERN, "Pick a date and time")
            .refine((value) => datetimeLocalToIso(value) !== null, "Not a real date and time"),
        notes: z.string().trim().max(MAX_NOTES_LENGTH, `Notes are limited to ${MAX_NOTES_LENGTH} characters`),
    })
    .superRefine((values, ctx) => {
        if (values.valueKind === "blood_pressure") {
            const pair = validateBloodPressureFields(values.systolic, values.diastolic);
            if (pair.systolicError) {
                ctx.addIssue({code: "custom", path: ["systolic"], message: pair.systolicError});
            }
            if (pair.diastolicError) {
                ctx.addIssue({code: "custom", path: ["diastolic"], message: pair.diastolicError});
            }
            return;
        }

        const raw = values.numericValue.trim();
        if (raw === "") {
            ctx.addIssue({code: "custom", path: ["numericValue"], message: "Value is required"});
        } else {
            const value = Number(raw);
            if (!Number.isFinite(value) || value <= 0) {
                ctx.addIssue({
                    code: "custom",
                    path: ["numericValue"],
                    message: "Value must be greater than zero",
                });
            } else if (value > MAX_MEASUREMENT_VALUE) {
                ctx.addIssue({
                    code: "custom",
                    path: ["numericValue"],
                    message: "Value looks too large",
                });
            }
        }
    });

export type MeasurementLogFormValues = z.infer<typeof measurementLogFormSchema>;

/** Component-wise BP validation for the form's two fields (messages per field). */
function validateBloodPressureFields(
    systolicRaw: string,
    diastolicRaw: string
): {
    systolicError: string | null;
    diastolicError: string | null;
    value: BloodPressureValue | null;
} {
    const parse = (raw: string): number | null => {
        const trimmed = raw.trim();
        if (trimmed === "") return null;
        const value = Number(trimmed);
        return Number.isInteger(value) && value > 0 ? value : null;
    };
    const systolic = parse(systolicRaw);
    const diastolic = parse(diastolicRaw);

    const systolicError =
        systolicRaw.trim() === ""
            ? "Required"
            : systolic === null
                ? "Whole mmHg number"
                : systolic < SYSTOLIC_RANGE[0] || systolic > SYSTOLIC_RANGE[1]
                    ? `Typically ${SYSTOLIC_RANGE[0]}–${SYSTOLIC_RANGE[1]}`
                    : null;
    const diastolicError =
        diastolicRaw.trim() === ""
            ? "Required"
            : diastolic === null
                ? "Whole mmHg number"
                : diastolic < DIASTOLIC_RANGE[0] || diastolic > DIASTOLIC_RANGE[1]
                    ? `Typically ${DIASTOLIC_RANGE[0]}–${DIASTOLIC_RANGE[1]}`
                    : null;

    if (
        !systolicError &&
        !diastolicError &&
        systolic !== null &&
        diastolic !== null &&
        systolic <= diastolic
    ) {
        return {
            systolicError: "Must be higher than diastolic",
            diastolicError: null,
            value: null,
        };
    }
    if (systolicError || diastolicError || systolic === null || diastolic === null) {
        return {systolicError, diastolicError, value: null};
    }
    return {systolicError: null, diastolicError: null, value: {systolic, diastolic}};
}

/**
 * Builds dialog defaults. Pass a log to prefill for editing; otherwise a
 * `type` seeds the tracker selection and the current instant.
 */
export function measurementLogToFormValues(
    log: MeasurementLog | null,
    types: MeasurementType[],
    selectedType?: MeasurementType | null
): MeasurementLogFormValues {
    if (log) {
        const type = types.find((candidate) => candidate.id === log.measurementTypeId) ?? null;
        const kind = type?.valueKind === "blood_pressure" ? "blood_pressure" : "numeric";
        const match = BLOOD_PRESSURE_PATTERN.exec(String(log.value).trim());
        return {
            measurementTypeId: log.measurementTypeId,
            valueKind: kind,
            numericValue: kind === "numeric" ? String(log.value) : "",
            systolic: match ? match[1] : "",
            diastolic: match ? match[2] : "",
            timestamp: isoToDatetimeLocal(log.timestamp),
            notes: log.notes ?? "",
        };
    }
    const type = selectedType ?? types[0] ?? null;
    const kind: MeasurementValueKind =
        type?.valueKind === "blood_pressure" ? "blood_pressure" : "numeric";
    return {
        measurementTypeId: type?.id ?? "",
        valueKind: kind,
        numericValue: "",
        systolic: "",
        diastolic: "",
        timestamp: isoToDatetimeLocal(new Date().toISOString()),
        notes: "",
    };
}

export interface ResolvedMeasurementLogValue {
    kind: MeasurementValueKind;
    /** Stored value for the canonical input; null when pieces are missing. */
    value: number | string | null;
}

/** Collapses the kind-dependent form fields into the stored value. */
export function resolveMeasurementLogValue(
    values: Pick<MeasurementLogFormValues, "valueKind" | "numericValue" | "systolic" | "diastolic">
): ResolvedMeasurementLogValue {
    const numeric =
        values.valueKind === "numeric" && values.numericValue.trim() !== ""
            ? Number(values.numericValue.trim())
            : null;
    const pair = validateBloodPressureFields(values.systolic, values.diastolic).value;
    return {
        kind: values.valueKind,
        value: toStoredValue(values.valueKind, numeric, pair),
    };
}

/** Converts validated form values into the canonical service input. */
export function toMeasurementLogInput(values: MeasurementLogFormValues): MeasurementLogInput {
    const resolved = resolveMeasurementLogValue(values);
    if (resolved.value === null) {
        // The form validated whichever fields this kind uses, so an
        // unresolvable value can't survive it; NaN keeps the type honest.
        return {
            measurementTypeId: values.measurementTypeId,
            value: Number.NaN,
            timestamp: datetimeLocalToIso(values.timestamp) ?? undefined,
            notes: values.notes.trim() || undefined,
        };
    }
    return {
        measurementTypeId: values.measurementTypeId,
        value: resolved.value,
        timestamp: datetimeLocalToIso(values.timestamp) ?? undefined,
        notes: values.notes.trim() || undefined,
    };
}

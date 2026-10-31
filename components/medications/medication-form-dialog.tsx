"use client";

import * as React from "react";
import {useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {TriangleAlert} from "lucide-react";

import type {DoseUnit, MassUnit, Medication, Schedule} from "@/lib/db/types";
import {
    DOSE_UNITS,
    MASS_UNITS,
    MEDICATION_TYPE_META,
    MEDICATION_TYPES,
    medicationTypeMeta,
} from "@/lib/medications/constants";
import {
    medicationFormSchema,
    type MedicationFormValues,
    medicationToFormValues,
    toMedicationInput,
} from "@/lib/medications/schema";
import {createMedication, updateMedication} from "@/lib/medications/service";
import {
    convertUnit,
    formatAmount,
    formatNumber,
    isMassUnit,
    IU_FALLBACK_WARNING,
    parseDecimalInput,
    roundAmount,
} from "@/lib/units";

import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,} from "@/components/ui/dialog";
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,} from "@/components/ui/form";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "@/components/ui/select";
import {Separator} from "@/components/ui/separator";
import {Switch} from "@/components/ui/switch";
import {Textarea} from "@/components/ui/textarea";
import {ConcentrationSummary, ScheduleSection} from "./reconstitution-panel";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Unit suffix rendered inside a numeric input field. */
function Suffix({unit}: { unit: string }) {
    return (
        <span
            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs tabular-nums">
            {unit}
        </span>
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** mg ↔ mcg cross-read for a stock amount (null when not applicable). */
function stockConversionHint(amount: number, unit: MedicationFormValues["unit"]): string | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (unit !== "mg" && unit !== "mcg") return null;
    const target: "mg" | "mcg" = unit === "mg" ? "mcg" : "mg";
    const converted = convertUnit(amount, unit, target);
    return converted ? `≈ ${formatAmount(converted.value, target)}` : null;
}

/** Parses a raw container count + per-container amount into a stock total. */
function computedStockTotal(
    vialCountRaw: string,
    perVialRaw: string
): { vials: number; perVial: number; total: number } | null {
    const vials = parseDecimalInput(vialCountRaw);
    const perVial = parseDecimalInput(perVialRaw);
    if (vials === undefined || vials < 0) return null;
    if (perVial === undefined || perVial <= 0) return null;
    return {vials, perVial, total: roundAmount(vials * perVial)};
}

/**
 * Builds a preview medication from raw reconstitution form strings. The vial
 * mass comes from the inventory per-vial field for mass-dosed peptides, or
 * from the dedicated reconstitution field for mL-dosed ones.
 */
function buildPreviewMedication(
    vialMass: string,
    vialMassUnit: MassUnit,
    bacWaterAmountMl: string,
    unit: DoseUnit
): Pick<Medication, "reconstitution" | "unit"> | null {
    const quantity = parseDecimalInput(vialMass);
    const water = parseDecimalInput(bacWaterAmountMl);
    if (quantity === undefined || quantity <= 0) return null;
    if (water === undefined || water <= 0) return null;
    return {
        unit,
        reconstitution: {
            vialQuantity: quantity,
            vialQuantityUnit: vialMassUnit,
            bacWaterAmountMl: water,
        },
    };
}

// ---------------------------------------------------------------------------
// Form body (mounts fresh for every dialog session via a key)
// ---------------------------------------------------------------------------

interface MedicationFormProps {
    medication: Medication | null;
    /** All schedules — active ones for this medication are previewed read-only. */
    schedules: Schedule[];
    onSaved: (medication: Medication, mode: "created" | "updated") => void;
    onCancel: () => void;
}

function MedicationForm({medication, schedules, onSaved, onCancel}: MedicationFormProps) {
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const defaults = medicationToFormValues(medication ?? undefined);
    const form = useForm<MedicationFormValues>({
        resolver: zodResolver(medicationFormSchema),
        defaultValues: defaults,
    });

    // Whole-form watch for the conditional sections and live previews. The
    // merged values are plain strings/booleans, so sections re-render per
    // keystroke — trivial for a dialog of this size and compiler-friendly.
    const watched = useWatch({control: form.control});
    const type = watched.type ?? defaults.type;
    const unit = watched.unit ?? defaults.unit;
    const hasReconstitution = watched.hasReconstitution ?? defaults.hasReconstitution;
    const vialQuantityUnit = watched.vialQuantityUnit ?? defaults.vialQuantityUnit;
    const vialCount = watched.vialCount ?? defaults.vialCount;
    const containerSize = watched.containerSize ?? defaults.containerSize;
    const vialQuantity = watched.vialQuantity ?? defaults.vialQuantity;
    const bacWaterAmountMl = watched.bacWaterAmountMl ?? defaults.bacWaterAmountMl;

    const meta = medicationTypeMeta(type);
    const isPeptide = type === "peptide";
    const reconstituted = isPeptide && hasReconstitution;
    // mL-dosed peptides size each vial by its BAC-water volume; the peptide
    // mass then needs its own input. Mass-dosed peptides reuse the per-vial
    // inventory amount as the vial mass — nothing to retype.
    const vialSizedByWater = reconstituted && unit === "mL";

    // Live stock preview: containers × per-container amount (the BAC-water
    // volume for mL-dosed reconstituted peptides).
    const stockTotal = computedStockTotal(
        vialCount,
        vialSizedByWater ? bacWaterAmountMl : containerSize
    );
    // mg ↔ mcg cross-read for the computed total.
    const stockConversion = stockTotal
        ? stockConversionHint(stockTotal.total, unit)
        : null;

    // Read-only echo of the BAC-water volume that sizes a vial (mL peptides).
    const bacWaterMl = parseDecimalInput(bacWaterAmountMl);
    const autoPerVialLabel =
        bacWaterMl !== undefined && bacWaterMl > 0
            ? `${formatNumber(bacWaterMl)} mL`
            : "Set BAC water below";

    // Read-only echo of the per-vial amount feeding the concentration math.
    const perVialAmount = parseDecimalInput(containerSize);
    const perVialEcho =
        perVialAmount !== undefined && perVialAmount > 0
            ? formatAmount(perVialAmount, unit)
            : "Set the per-vial amount above";

    // Live reconstitution preview built from raw watched values.
    const vialMassUnit: MassUnit | null = vialSizedByWater
        ? vialQuantityUnit
        : isMassUnit(unit)
            ? unit
            : null;
    const previewMedication =
        reconstituted && vialMassUnit
            ? buildPreviewMedication(
                vialSizedByWater ? vialQuantity : containerSize,
                vialMassUnit,
                bacWaterAmountMl,
                unit
            )
            : null;

    const activeSchedules = React.useMemo(
        () => schedules.filter((s) => s.medicationId === medication?.id && s.active),
        [schedules, medication?.id]
    );
    const referenceDose = activeSchedules[0]
        ? {amount: activeSchedules[0].doseAmount, unit: activeSchedules[0].unit}
        : null;

    const onSubmit = async (formValues: MedicationFormValues) => {
        setSaving(true);
        setError(null);
        try {
            const input = toMedicationInput(formValues);
            const saved = medication
                ? await updateMedication(medication.id, input)
                : await createMedication(input);
            onSaved(saved, medication ? "updated" : "created");
        } catch (submitError: unknown) {
            setError(errorMessage(submitError));
            setSaving(false);
        }
    };

    const containerLabel =
        meta.containerNoun === "container"
            ? "Containers"
            : `${meta.containerNoun[0].toUpperCase()}${meta.containerNoun.slice(1)}s`;

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
                noValidate
            >
                {/* Basics */}
                <FormField
                    control={form.control}
                    name="name"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl>
                                <Input
                                    placeholder="e.g. BPC-157, Semaglutide, Vitamin D"
                                    autoComplete="off"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                        control={form.control}
                        name="type"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Type</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value}>
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select a type"/>
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        {MEDICATION_TYPES.map((value) => {
                                            const typeMeta = MEDICATION_TYPE_META[value];
                                            return (
                                                <SelectItem key={value} value={value}>
                                                    <typeMeta.icon
                                                        className="size-4"
                                                        aria-hidden
                                                    />
                                                    {typeMeta.label}
                                                </SelectItem>
                                            );
                                        })}
                                    </SelectContent>
                                </Select>
                                <FormDescription>{meta.description}</FormDescription>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="unit"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Dose &amp; stock unit</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value}>
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select a unit"/>
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        {DOSE_UNITS.map((value) => (
                                            <SelectItem key={value} value={value}>
                                                {value === "mL" ? "mL (volume)" : value}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    {unit === "IU" && (
                        <p className="text-amber-600 dark:text-amber-400 sm:col-span-2 inline-flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                            <TriangleAlert
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden
                            />
                            {IU_FALLBACK_WARNING}
                        </p>
                    )}

                    <FormField
                        control={form.control}
                        name="halfLifeHours"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>
                                    Half-life{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </FormLabel>
                                <div className="relative">
                                    <FormControl>
                                        <Input
                                            inputMode="decimal"
                                            placeholder="168"
                                            className="pr-14"
                                            {...field}
                                        />
                                    </FormControl>
                                    <Suffix unit="hours"/>
                                </div>
                                <FormDescription>
                                    Powers concentration curves — e.g. 168 h for a 7-day
                                    half-life.
                                </FormDescription>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />
                </div>

                <Separator/>

                {/* Inventory — stock is derived from containers × per-container */}
                <fieldset className="flex flex-col gap-4">
                    <legend className="text-sm font-medium">Inventory</legend>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            control={form.control}
                            name="vialCount"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>{containerLabel}</FormLabel>
                                    <div className="relative">
                                        <FormControl>
                                            <Input
                                                inputMode="numeric"
                                                placeholder="0"
                                                className="pr-14"
                                                {...field}
                                            />
                                        </FormControl>
                                        <Suffix
                                            unit={`${meta.containerNoun}s`}
                                        />
                                    </div>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        {vialSizedByWater ? (
                            <div className="flex flex-col gap-2">
                                <label className="text-sm leading-none font-medium">
                                    Per {meta.containerNoun}{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (auto)
                                    </span>
                                </label>
                                <p className="bg-muted/30 flex h-9 items-center rounded-md border px-3 text-sm tabular-nums">
                                    {autoPerVialLabel}
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Each vial counts as the BAC water mixed
                                    into it (set below).
                                </p>
                            </div>
                        ) : (
                            <FormField
                                control={form.control}
                                name="containerSize"
                                render={({field}) => (
                                    <FormItem>
                                        <FormLabel>
                                            Per {meta.containerNoun}
                                        </FormLabel>
                                        <div className="relative">
                                            <FormControl>
                                                <Input
                                                    inputMode="decimal"
                                                    placeholder="5"
                                                    className="pr-14"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <Suffix unit={unit ?? ""}/>
                                        </div>
                                        <FormDescription>
                                            Total stock is {meta.containerNoun}s on
                                            hand × this amount
                                            {reconstituted
                                                ? " — also the peptide mass per vial for reconstitution."
                                                : "."}
                                        </FormDescription>
                                        <FormMessage/>
                                    </FormItem>
                                )}
                            />
                        )}

                        <FormField
                            control={form.control}
                            name="lowStockThreshold"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>
                                        Low-stock alert at{" "}
                                        <span className="text-muted-foreground font-normal">
                                            (optional)
                                        </span>
                                    </FormLabel>
                                    <div className="relative">
                                        <FormControl>
                                            <Input
                                                inputMode="decimal"
                                                placeholder="1"
                                                className="pr-14"
                                                {...field}
                                            />
                                        </FormControl>
                                        <Suffix unit={unit ?? ""}/>
                                    </div>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    </div>
                    {stockTotal ? (
                        <p className="bg-muted/30 rounded-lg border px-3 py-2.5 text-xs">
                            <span className="font-medium">Total stock</span>{" "}
                            <span className="tabular-nums font-medium">
                                {formatAmount(stockTotal.total, unit)}
                            </span>
                            {stockConversion && (
                                <span className="text-muted-foreground">
                                    {" "}
                                    ({stockConversion})
                                </span>
                            )}
                            <span className="text-muted-foreground">
                                {" "}
                                · {stockTotal.vials}{" "}
                                {stockTotal.vials === 1
                                    ? meta.containerNoun
                                    : `${meta.containerNoun}s`}{" "}
                                × {formatAmount(stockTotal.perVial, unit)}
                            </span>
                        </p>
                    ) : (
                        <p className="text-muted-foreground text-xs">
                            Total stock is calculated from {meta.containerNoun}s
                            on hand × the amount per {meta.containerNoun}.
                        </p>
                    )}
                </fieldset>

                {/* Reconstitution — peptides only */}
                {isPeptide && (
                    <>
                        <Separator/>
                        <fieldset className="flex flex-col gap-4">
                            <legend className="text-sm font-medium">Reconstitution</legend>
                            <FormField
                                control={form.control}
                                name="hasReconstitution"
                                render={({field}) => (
                                    <FormItem
                                        className="flex flex-row items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                                        <div className="min-w-0">
                                            <FormLabel className="text-sm">
                                                Reconstituted vial
                                            </FormLabel>
                                            <FormDescription className="text-xs">
                                                Track BAC water and get dose volumes on your
                                                U-100 syringe.
                                            </FormDescription>
                                        </div>
                                        <FormControl>
                                            <Switch
                                                checked={field.value}
                                                onCheckedChange={field.onChange}
                                            />
                                        </FormControl>
                                    </FormItem>
                                )}
                            />

                            {hasReconstitution && (
                                <>
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        {vialSizedByWater ? (
                                            <FormField
                                                control={form.control}
                                                name="vialQuantity"
                                                render={({field}) => (
                                                    <FormItem>
                                                        <FormLabel>Peptide per vial</FormLabel>
                                                        <div className="flex gap-2">
                                                            <div className="relative flex-1">
                                                                <FormControl>
                                                                    <Input
                                                                        inputMode="decimal"
                                                                        placeholder="5"
                                                                        className="pr-12"
                                                                        {...field}
                                                                    />
                                                                </FormControl>
                                                                <Suffix
                                                                    unit={
                                                                        vialQuantityUnit ?? "mg"
                                                                    }
                                                                />
                                                            </div>
                                                            <FormField
                                                                control={form.control}
                                                                name="vialQuantityUnit"
                                                                render={({
                                                                             field: unitField,
                                                                         }) => (
                                                                    <Select
                                                                        onValueChange={
                                                                            unitField.onChange
                                                                        }
                                                                        value={unitField.value}
                                                                    >
                                                                        <FormControl>
                                                                            <SelectTrigger
                                                                                className="w-[4.5rem]"
                                                                                aria-label="Vial quantity unit"
                                                                            >
                                                                                <SelectValue/>
                                                                            </SelectTrigger>
                                                                        </FormControl>
                                                                        <SelectContent>
                                                                            {MASS_UNITS.map(
                                                                                (value) => (
                                                                                    <SelectItem
                                                                                        key={
                                                                                            value
                                                                                        }
                                                                                        value={
                                                                                            value
                                                                                        }
                                                                                    >
                                                                                        {value}
                                                                                    </SelectItem>
                                                                                )
                                                                            )}
                                                                        </SelectContent>
                                                                    </Select>
                                                                )}
                                                            />
                                                        </div>
                                                        <FormMessage/>
                                                    </FormItem>
                                                )}
                                            />
                                        ) : (
                                            <div className="flex flex-col gap-2">
                                                <label className="text-sm leading-none font-medium">
                                                    Peptide per vial
                                                </label>
                                                <p className="bg-muted/30 flex h-9 items-center rounded-md border px-3 text-sm tabular-nums">
                                                    {perVialEcho}
                                                </p>
                                                <p className="text-muted-foreground text-xs">
                                                    Taken from the per-vial amount
                                                    in Inventory — no need to
                                                    retype it.
                                                </p>
                                            </div>
                                        )}

                                        <FormField
                                            control={form.control}
                                            name="bacWaterAmountMl"
                                            render={({field}) => (
                                                <FormItem>
                                                    <FormLabel>BAC water added</FormLabel>
                                                    <div className="relative">
                                                        <FormControl>
                                                            <Input
                                                                inputMode="decimal"
                                                                placeholder="2"
                                                                className="pr-14"
                                                                {...field}
                                                            />
                                                        </FormControl>
                                                        <Suffix unit="mL"/>
                                                    </div>
                                                    <FormDescription>
                                                        {vialSizedByWater
                                                            ? "Bacteriostatic water mixed into each vial — also sets each vial's stock volume."
                                                            : "Bacteriostatic water mixed into each vial — combined with the per-vial amount above."}
                                                    </FormDescription>
                                                    <FormMessage/>
                                                </FormItem>
                                            )}
                                        />
                                    </div>
                                    <ConcentrationSummary
                                        medication={previewMedication}
                                        referenceDose={referenceDose}
                                    />
                                </>
                            )}
                        </fieldset>
                    </>
                )}

                {/* Notes */}
                <FormField
                    control={form.control}
                    name="notes"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>
                                Notes{" "}
                                <span className="text-muted-foreground font-normal">
                                    (optional)
                                </span>
                            </FormLabel>
                            <FormControl>
                                <Textarea
                                    rows={3}
                                    placeholder="Source, batch, storage, reactions…"
                                    className="resize-none"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                {/* Linked schedules (read-only, edit mode) */}
                {medication && activeSchedules.length > 0 && (
                    <ScheduleSection
                        medication={{...medication, ...(previewMedication ?? {})}}
                        schedules={activeSchedules}
                    />
                )}

                {error && (
                    <p className="text-destructive text-sm" role="alert">
                        {error}
                    </p>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onCancel}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                        {saving
                            ? "Saving…"
                            : medication
                                ? "Save changes"
                                : "Add medication"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export interface MedicationFormDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Medication being edited; null when creating. */
    medication: Medication | null;
    /** All schedules — active ones for the edited medication are previewed. */
    schedules: Schedule[];
    onSaved: (medication: Medication, mode: "created" | "updated") => void;
}

export function MedicationFormDialog({
                                         open,
                                         onOpenChange,
                                         medication,
                                         schedules,
                                         onSaved,
                                     }: MedicationFormDialogProps) {
    const handleSaved = React.useCallback(
        (saved: Medication, mode: "created" | "updated") => {
            onSaved(saved, mode);
            onOpenChange(false);
        },
        [onSaved, onOpenChange]
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        {medication ? "Edit medication" : "Add medication"}
                    </DialogTitle>
                    <DialogDescription>
                        {medication
                            ? "Update details, inventory or reconstitution info."
                            : "Track a medication, peptide or supplement with its inventory."}
                    </DialogDescription>
                </DialogHeader>

                {/* Keyed per target: every dialog session starts with a fresh,
                    default-filled form (no reset effects needed). */}
                {open && (
                    <MedicationForm
                        key={medication?.id ?? "create"}
                        medication={medication}
                        schedules={schedules}
                        onSaved={handleSaved}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

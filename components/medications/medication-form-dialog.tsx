"use client";

import * as React from "react";
import {useFieldArray, useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {Plus, Trash2, TriangleAlert} from "lucide-react";

import type {DoseUnit, MassUnit, Medication, Schedule} from "@/lib/db/types";
import {
    DOSE_UNITS,
    doseUnitLabel,
    MASS_UNITS,
    MEDICATION_TYPE_META,
    MEDICATION_TYPES,
    medicationTypeMeta,
} from "@/lib/medications/constants";
import {amountInMedicationUnit} from "@/lib/medications/derived";
import {
    medicationFormSchema,
    type MedicationFormValues,
    medicationToFormValues,
    newInventoryLotFormValues,
    toMedicationInput,
} from "@/lib/medications/schema";
import {createMedication, updateMedication} from "@/lib/medications/service";
import {
    convertUnit,
    formatAmount,
    formatNumber,
    formatPrice,
    isMassUnit,
    IU_FALLBACK_WARNING,
    parseDecimalInput,
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

/**
 * Builds a preview medication from raw reconstitution form strings. The vial
 * mass is typed explicitly whenever reconstitution is enabled, so mixed
 * inventory lots can never silently change the concentration.
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

    const {fields, append, remove} = useFieldArray({
        control: form.control,
        name: "inventoryLots",
    });

    // Whole-form watch for the conditional sections and live previews. The
    // merged values are plain strings/booleans, so sections re-render per
    // keystroke — trivial for a dialog of this size and compiler-friendly.
    const watchedValues = useWatch({control: form.control});
    // Merge over the defaults so every field is always a complete row while
    // the dialog mounts (useWatch can be sparse on the first render).
    const watched = {
        ...defaults,
        ...(watchedValues ?? {}),
    } as MedicationFormValues;
    const type = watched.type;
    const unit = watched.unit;
    const hasReconstitution = watched.hasReconstitution;
    const vialQuantityUnit = watched.vialQuantityUnit;
    const vialQuantity = watched.vialQuantity;
    const bacWaterAmountMl = watched.bacWaterAmountMl;
    const inventoryLots = watched.inventoryLots;

    const meta = medicationTypeMeta(type);
    const isPeptide = type === "peptide";
    const reconstituted = isPeptide && hasReconstitution;

    // Live reconstitution preview built from raw watched values.
    const previewMedication = reconstituted
        ? buildPreviewMedication(
            vialQuantity,
            vialQuantityUnit,
            bacWaterAmountMl,
            unit
        )
        : null;

    // Aggregate stock preview: sum every lot in the medication's unit. Lots
    // whose unit can't be expressed there are flagged instead of guessed.
    const stockPreview = inventoryLots.reduce(
        (preview, lot) => {
            const vials = parseDecimalInput(lot.vialCount) ?? 0;
            const content = parseDecimalInput(lot.contentAmount) ?? 0;
            const price = parseDecimalInput(lot.pricePerContainer);
            if (vials < 0 || content <= 0) return preview;
            const raw = vials * content;
            preview.vials += vials;
            preview.lots += content > 0 ? 1 : 0;
            if (price !== undefined && price >= 0) {
                preview.price += vials * price;
                preview.pricedLots += 1;
            }
            const converted = amountInMedicationUnit(
                raw,
                lot.contentUnit,
                previewMedication ?? {unit}
            );
            if (converted) preview.quantity += converted.value;
            else if (raw > 0) preview.unconvertible += 1;
            return preview;
        },
        {quantity: 0, vials: 0, lots: 0, unconvertible: 0, price: 0, pricedLots: 0}
    );
    const stockConversion =
        stockPreview.quantity > 0
            ? stockConversionHint(stockPreview.quantity, unit)
            : null;

    const handleReconstitutionToggle = (
        checked: boolean,
        onChange: (value: boolean) => void
    ) => {
        onChange(checked);
        if (!checked || vialQuantity.trim() !== "") return;
        // Helpful default: copy the first mass-based lot's content.
        const first = inventoryLots[0];
        if (!first) return;
        const amount = parseDecimalInput(first.contentAmount);
        if (amount === undefined || amount <= 0) return;
        if (!isMassUnit(first.contentUnit)) return;
        form.setValue("vialQuantity", first.contentAmount);
        form.setValue("vialQuantityUnit", first.contentUnit);
    };

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
                                                {doseUnitLabel(value)}
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

                {/* Inventory — one card per purchase/delivery lot */}
                <fieldset className="flex flex-col gap-3">
                    <legend className="text-sm font-medium">Inventory lots</legend>
                    <p className="text-muted-foreground text-xs">
                        Add each purchase or delivery separately. Stock is the sum of{" "}
                        {containerLabel.toLowerCase()} × content per{" "}
                        {meta.containerNoun}.
                    </p>

                    {fields.length === 0 && (
                        <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-xs">
                            No inventory lots yet. Add one to track stock and how
                            long it will last.
                        </p>
                    )}

                    {fields.map((field, index) => {
                        const lot = inventoryLots[index] ?? field;
                        const vials = parseDecimalInput(lot.vialCount) ?? 0;
                        const content = parseDecimalInput(lot.contentAmount) ?? 0;
                        const price = parseDecimalInput(lot.pricePerContainer);
                        const total = vials > 0 && content > 0 ? vials * content : 0;
                        const lotPrice =
                            price !== undefined && price >= 0 && vials > 0
                                ? vials * price
                                : null;
                        return (
                            <div
                                key={field.id}
                                className="bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">
                                            Lot {index + 1}
                                        </p>
                                        <p className="text-muted-foreground text-xs tabular-nums">
                                            {vials > 0 && content > 0
                                                ? `${formatNumber(vials)} × ${formatAmount(content, lot.contentUnit)} = ${formatAmount(total, lot.contentUnit)}`
                                                : "Enter containers and their content."}
                                        </p>
                                        {lotPrice !== null && (
                                            <p className="text-muted-foreground text-xs tabular-nums">
                                                Lot value {formatPrice(lotPrice)}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-7 shrink-0"
                                        onClick={() => remove(index)}
                                        aria-label={`Remove inventory lot ${index + 1}`}
                                    >
                                        <Trash2 className="size-3.5" aria-hidden/>
                                    </Button>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-3">
                                    <FormField
                                        control={form.control}
                                        name={`inventoryLots.${index}.vialCount`}
                                        render={({field: rowField}) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">
                                                    Number of {containerLabel.toLowerCase()}
                                                </FormLabel>
                                                <FormControl>
                                                    <Input
                                                        inputMode="numeric"
                                                        placeholder="1"
                                                        className="tabular-nums"
                                                        {...rowField}
                                                    />
                                                </FormControl>
                                                <FormMessage/>
                                            </FormItem>
                                        )}
                                    />
                                    <FormField
                                        control={form.control}
                                        name={`inventoryLots.${index}.contentAmount`}
                                        render={({field: rowField}) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">
                                                    Content per {meta.containerNoun}
                                                </FormLabel>
                                                <FormControl>
                                                    <Input
                                                        inputMode="decimal"
                                                        placeholder="5"
                                                        className="tabular-nums"
                                                        {...rowField}
                                                    />
                                                </FormControl>
                                                <FormMessage/>
                                            </FormItem>
                                        )}
                                    />
                                    <FormField
                                        control={form.control}
                                        name={`inventoryLots.${index}.contentUnit`}
                                        render={({field: rowField}) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">
                                                    Content unit
                                                </FormLabel>
                                                <Select
                                                    onValueChange={rowField.onChange}
                                                    value={rowField.value}
                                                >
                                                    <FormControl>
                                                        <SelectTrigger className="w-full">
                                                            <SelectValue/>
                                                        </SelectTrigger>
                                                    </FormControl>
                                                    <SelectContent>
                                                        {DOSE_UNITS.map((value) => (
                                                            <SelectItem key={value} value={value}>
                                                                {doseUnitLabel(value)}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <FormMessage/>
                                            </FormItem>
                                        )}
                                    />
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <FormField
                                        control={form.control}
                                        name={`inventoryLots.${index}.orderDate`}
                                        render={({field: rowField}) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">
                                                    Order date{" "}
                                                    <span className="text-muted-foreground font-normal">
                                                        (optional)
                                                    </span>
                                                </FormLabel>
                                                <FormControl>
                                                    <Input
                                                        type="date"
                                                        className="tabular-nums"
                                                        {...rowField}
                                                    />
                                                </FormControl>
                                                <FormMessage/>
                                            </FormItem>
                                        )}
                                    />
                                    <FormField
                                        control={form.control}
                                        name={`inventoryLots.${index}.deliveryDate`}
                                        render={({field: rowField}) => (
                                            <FormItem>
                                                <FormLabel className="text-xs">
                                                    Delivery date{" "}
                                                    <span className="text-muted-foreground font-normal">
                                                        (optional)
                                                    </span>
                                                </FormLabel>
                                                <FormControl>
                                                    <Input
                                                        type="date"
                                                        className="tabular-nums"
                                                        {...rowField}
                                                    />
                                                </FormControl>
                                                <FormMessage/>
                                            </FormItem>
                                        )}
                                    />
                                </div>

                                <FormField
                                    control={form.control}
                                    name={`inventoryLots.${index}.vendor`}
                                    render={({field: rowField}) => (
                                        <FormItem>
                                            <FormLabel className="text-xs">
                                                Vendor{" "}
                                                <span className="text-muted-foreground font-normal">
                                                    (optional)
                                                </span>
                                            </FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Vendor / supplier, batch info…"
                                                    {...rowField}
                                                />
                                            </FormControl>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name={`inventoryLots.${index}.pricePerContainer`}
                                    render={({field: rowField}) => (
                                        <FormItem>
                                            <FormLabel className="text-xs">
                                                Price per {meta.containerNoun}{" "}
                                                <span className="text-muted-foreground font-normal">
                                                    (optional)
                                                </span>
                                            </FormLabel>
                                            <div className="relative">
                                                <FormControl>
                                                    <Input
                                                        inputMode="decimal"
                                                        placeholder="29.99"
                                                        className="pr-8 tabular-nums"
                                                        {...rowField}
                                                    />
                                                </FormControl>
                                                <span
                                                    className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                                    $
                                                </span>
                                            </div>
                                            <FormDescription className="text-xs">
                                                USD per {meta.containerNoun}, not per content
                                                unit.
                                            </FormDescription>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name={`inventoryLots.${index}.coaUrlsText`}
                                    render={({field: rowField}) => (
                                        <FormItem>
                                            <FormLabel className="text-xs">
                                                COA links{" "}
                                                <span className="text-muted-foreground font-normal">
                                                    (optional)
                                                </span>
                                            </FormLabel>
                                            <FormControl>
                                                <Textarea
                                                    rows={2}
                                                    placeholder="https://example.com/coa.pdf (one per line)"
                                                    className="resize-none text-xs"
                                                    {...rowField}
                                                />
                                            </FormControl>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name={`inventoryLots.${index}.notes`}
                                    render={({field: rowField}) => (
                                        <FormItem>
                                            <FormLabel className="text-xs">
                                                Lot note{" "}
                                                <span className="text-muted-foreground font-normal">
                                                    (optional)
                                                </span>
                                            </FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Batch, storage, appearance…"
                                                    {...rowField}
                                                />
                                            </FormControl>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />
                            </div>
                        );
                    })}

                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => append(newInventoryLotFormValues(unit))}
                    >
                        <Plus className="size-4" aria-hidden/>
                        Add inventory lot
                    </Button>

                    <FormField
                        control={form.control}
                        name="lowStockThreshold"
                        render={({field}) => (
                            <FormItem className="sm:max-w-xs">
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

                    {stockPreview.quantity > 0 ? (
                        <p className="bg-muted/30 rounded-lg border px-3 py-2.5 text-xs">
                            <span className="font-medium">Total stock</span>{" "}
                            <span className="tabular-nums font-medium">
                                {formatAmount(stockPreview.quantity, unit)}
                            </span>
                            {stockConversion && (
                                <span className="text-muted-foreground">
                                    {" "}
                                    ({stockConversion})
                                </span>
                            )}
                            <span className="text-muted-foreground">
                                {" "}
                                · {formatNumber(stockPreview.vials)}{" "}
                                {stockPreview.vials === 1
                                    ? meta.containerNoun
                                    : `${meta.containerNoun}s`}{" "}
                                across {stockPreview.lots}{" "}
                                {stockPreview.lots === 1 ? "lot" : "lots"}
                            </span>
                        </p>
                    ) : (
                        <p className="text-muted-foreground text-xs">
                            Total stock appears here once a lot has containers and
                            content.
                        </p>
                    )}
                    {stockPreview.unconvertible > 0 && (
                        <p className="text-amber-600 dark:text-amber-400 inline-flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden/>
                            {stockPreview.unconvertible}{" "}
                            {stockPreview.unconvertible === 1 ? "lot uses" : "lots use"}{" "}
                            a content unit that can’t be expressed in {unit}. Those
                            lots are excluded from the total and duration.
                        </p>
                    )}
                    {stockPreview.pricedLots > 0 && (
                        <p className="bg-muted/30 rounded-lg border px-3 py-2.5 text-xs">
                            <span className="font-medium">Total price</span>{" "}
                            <span className="tabular-nums font-medium">
                                {formatPrice(stockPreview.price)}
                            </span>
                            <span className="text-muted-foreground">
                                {" "}
                                · {stockPreview.pricedLots}{" "}
                                {stockPreview.pricedLots === 1 ? "priced lot" : "priced lots"}
                                {stockPreview.lots > stockPreview.pricedLots &&
                                    ` · ${stockPreview.lots - stockPreview.pricedLots} unpriced excluded`}
                            </span>
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
                                                onCheckedChange={(checked) =>
                                                    handleReconstitutionToggle(
                                                        checked,
                                                        field.onChange
                                                    )
                                                }
                                            />
                                        </FormControl>
                                    </FormItem>
                                )}
                            />

                            {hasReconstitution && (
                                <>
                                    <div className="grid gap-4 sm:grid-cols-2">
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
                                                                                    key={value}
                                                                                    value={value}
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
                                                    <FormDescription className="text-xs">
                                                        Mass of peptide in one
                                                        vial — independent of how
                                                        many lots you stock.
                                                    </FormDescription>
                                                    <FormMessage/>
                                                </FormItem>
                                            )}
                                        />

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
                                                    <FormDescription className="text-xs">
                                                        Bacteriostatic water mixed into each
                                                        vial — combined with the peptide mass
                                                        above.
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

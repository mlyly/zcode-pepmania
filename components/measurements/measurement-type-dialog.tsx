"use client";

import * as React from "react";
import {useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {TriangleAlert} from "lucide-react";

import type {MeasurementType} from "@/lib/db/types";
import {MEASUREMENT_TYPE_PRESETS} from "@/lib/measurements/constants";
import {
    measurementTypeFormSchema,
    type MeasurementTypeFormValues,
    measurementTypeToFormValues,
    toMeasurementTypeInput,
} from "@/lib/measurements/schema";
import {createMeasurementType, updateMeasurementType} from "@/lib/measurements/service";

import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,} from "@/components/ui/dialog";
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,} from "@/components/ui/form";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "@/components/ui/select";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Form body (mounts fresh for every dialog session via a key)
// ---------------------------------------------------------------------------

interface MeasurementTypeFormProps {
    type: MeasurementType | null;
    /** Readings stored for this tracker — locks the kind once non-zero. */
    logCount: number;
    onSaved: (type: MeasurementType, mode: "created" | "updated") => void;
    onCancel: () => void;
}

function MeasurementTypeForm({type, logCount, onSaved, onCancel}: MeasurementTypeFormProps) {
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const form = useForm<MeasurementTypeFormValues>({
        resolver: zodResolver(measurementTypeFormSchema),
        defaultValues: measurementTypeToFormValues(type),
    });

    const isBuiltin = type !== null && !type.isCustom;
    const kindLocked = isBuiltin || (type !== null && logCount > 0);
    const watched = useWatch({control: form.control});

    const applyPreset = (preset: (typeof MEASUREMENT_TYPE_PRESETS)[number]) => {
        form.setValue("name", preset.name, {shouldValidate: true});
        form.setValue("unit", preset.unit, {shouldValidate: true});
        if (!kindLocked) {
            form.setValue("valueKind", preset.valueKind, {shouldValidate: true});
        }
    };

    const submit = async (values: MeasurementTypeFormValues) => {
        setSaving(true);
        setError(null);
        try {
            const input = toMeasurementTypeInput(values);
            const saved = type
                ? await updateMeasurementType(type.id, input)
                : await createMeasurementType(input);
            onSaved(saved, type ? "updated" : "created");
        } catch (submitError: unknown) {
            setError(errorMessage(submitError));
            setSaving(false);
        }
    };

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(submit)}
                className="flex flex-col gap-4"
                noValidate
            >
                {!type && (
                    <div className="flex flex-wrap gap-1.5">
                        {MEASUREMENT_TYPE_PRESETS.map((preset) => (
                            <Button
                                key={`${preset.name}-${preset.unit}`}
                                type="button"
                                variant="outline"
                                size="sm"
                                className="rounded-full text-xs"
                                onClick={() => applyPreset(preset)}
                            >
                                {preset.name} ({preset.unit})
                            </Button>
                        ))}
                    </div>
                )}

                <FormField
                    control={form.control}
                    name="name"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl>
                                <Input placeholder="e.g. Waist Circumference" {...field}/>
                            </FormControl>
                            {isBuiltin && (
                                <FormDescription>
                                    Built-in tracker — rename is fine, but it can&apos;t be deleted.
                                </FormDescription>
                            )}
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                        control={form.control}
                        name="unit"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Unit</FormLabel>
                                <FormControl>
                                    <Input placeholder="e.g. kg, cm, %, mmol/L" {...field}/>
                                </FormControl>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="valueKind"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Reading shape</FormLabel>
                                <Select
                                    onValueChange={field.onChange}
                                    value={field.value}
                                    disabled={kindLocked}
                                >
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue/>
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        <SelectItem value="numeric">Single number</SelectItem>
                                        <SelectItem value="blood_pressure">
                                            Blood pressure (sys/dia)
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />
                </div>

                {kindLocked && (watched.valueKind ?? "numeric") === "blood_pressure" && (
                    <p className="text-muted-foreground text-sm">
                        Readings are recorded as a systolic/diastolic pair, e.g. 120/80.
                    </p>
                )}

                {error && (
                    <p className="text-destructive flex items-start gap-1.5 text-sm" role="alert">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden/>
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
                        {saving ? "Saving…" : type ? "Save tracker" : "Create tracker"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export interface MeasurementTypeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Tracker being edited; null when creating. */
    type: MeasurementType | null;
    /** Reading count for the edited tracker (locks its kind when > 0). */
    logCount: number;
    onSaved: (type: MeasurementType, mode: "created" | "updated") => void;
}

export function MeasurementTypeDialog({
                                          open,
                                          onOpenChange,
                                          type,
                                          logCount,
                                          onSaved,
                                      }: MeasurementTypeDialogProps) {
    const handleSaved = React.useCallback(
        (saved: MeasurementType, mode: "created" | "updated") => {
            onSaved(saved, mode);
            onOpenChange(false);
        },
        [onSaved, onOpenChange]
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {type ? `Edit ${type.name}` : "New tracker"}
                    </DialogTitle>
                    <DialogDescription>
                        {type
                            ? "Adjust the display name, unit or reading shape."
                            : "Track anything you measure — body fat %, waist, glucose, heart rate…"}
                    </DialogDescription>
                </DialogHeader>

                {open && (
                    <MeasurementTypeForm
                        key={type?.id ?? "create"}
                        type={type}
                        logCount={logCount}
                        onSaved={handleSaved}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

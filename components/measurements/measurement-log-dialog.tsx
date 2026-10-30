"use client";

import * as React from "react";
import {useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {TriangleAlert} from "lucide-react";

import type {MeasurementLog, MeasurementType} from "@/lib/db/types";
import {effectiveKind} from "@/lib/measurements/derived";
import {
    measurementLogFormSchema,
    type MeasurementLogFormValues,
    measurementLogToFormValues,
    toMeasurementLogInput,
} from "@/lib/measurements/schema";
import {logMeasurement, updateMeasurementLog} from "@/lib/measurements/service";
import {measurementTypeIcon} from "@/lib/measurements/constants";

import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,} from "@/components/ui/dialog";
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,} from "@/components/ui/form";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "@/components/ui/select";
import {Textarea} from "@/components/ui/textarea";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Form body (mounts fresh for every dialog session via a key)
// ---------------------------------------------------------------------------

interface MeasurementLogFormProps {
    log: MeasurementLog | null;
    types: MeasurementType[];
    /** Tracker preselected in create mode (null → first type). */
    selectedType: MeasurementType | null;
    onSaved: (log: MeasurementLog, mode: "created" | "updated") => void;
    onCancel: () => void;
}

function MeasurementLogForm({
                                log,
                                types,
                                selectedType,
                                onSaved,
                                onCancel,
                            }: MeasurementLogFormProps) {
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const form = useForm<MeasurementLogFormValues>({
        resolver: zodResolver(measurementLogFormSchema),
        defaultValues: measurementLogToFormValues(log, types, selectedType),
    });

    const watched = useWatch({control: form.control});
    const kind = watched.valueKind ?? "numeric";
    const unit = React.useMemo(
        () =>
            types.find((type) => type.id === (watched.measurementTypeId ?? ""))?.unit ?? "",
        [types, watched.measurementTypeId]
    );

    // Re-selecting a tracker re-derives the reading shape (the schema keys
    // its validation off `valueKind`, and the fields shown follow it).
    const handleTypeChange = (typeId: string) => {
        const type = types.find((candidate) => candidate.id === typeId) ?? null;
        form.setValue("measurementTypeId", typeId, {shouldValidate: true});
        form.setValue("valueKind", effectiveKind(type), {shouldValidate: true});
        // Clear the fields the *other* shape uses so stale input can't ship.
        form.setValue("numericValue", "");
        form.setValue("systolic", "");
        form.setValue("diastolic", "");
    };

    const submit = async (values: MeasurementLogFormValues) => {
        setSaving(true);
        setError(null);
        try {
            const input = toMeasurementLogInput(values);
            if (input.timestamp === undefined) {
                throw new Error("Pick a date and time.");
            }
            const saved = log
                ? await updateMeasurementLog(log.id, input)
                : await logMeasurement(input);
            onSaved(saved, log ? "updated" : "created");
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
                <FormField
                    control={form.control}
                    name="measurementTypeId"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Tracker</FormLabel>
                            <Select onValueChange={handleTypeChange} value={field.value}>
                                <FormControl>
                                    <SelectTrigger className="w-full">
                                        <SelectValue placeholder="Choose a tracker"/>
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    {types.map((type) => {
                                        const TypeIcon = measurementTypeIcon(type);
                                        return (
                                            <SelectItem key={type.id} value={type.id}>
                                                <TypeIcon className="size-4" aria-hidden/>
                                                {type.name}
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                {kind === "blood_pressure" ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            control={form.control}
                            name="systolic"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>Systolic</FormLabel>
                                    <div className="relative">
                                        <FormControl>
                                            <Input
                                                inputMode="numeric"
                                                placeholder="e.g. 120"
                                                className="pr-14 tabular-nums"
                                                {...field}
                                            />
                                        </FormControl>
                                        <span
                                            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                            {unit || "mmHg"}
                                        </span>
                                    </div>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="diastolic"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>Diastolic</FormLabel>
                                    <div className="relative">
                                        <FormControl>
                                            <Input
                                                inputMode="numeric"
                                                placeholder="e.g. 80"
                                                className="pr-14 tabular-nums"
                                                {...field}
                                            />
                                        </FormControl>
                                        <span
                                            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                            {unit || "mmHg"}
                                        </span>
                                    </div>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    </div>
                ) : (
                    <FormField
                        control={form.control}
                        name="numericValue"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Value</FormLabel>
                                <div className="relative">
                                    <FormControl>
                                        <Input
                                            inputMode="decimal"
                                            placeholder="e.g. 72.4"
                                            className="pr-14 tabular-nums"
                                            {...field}
                                        />
                                    </FormControl>
                                    <span
                                        className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                        {unit}
                                    </span>
                                </div>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />
                )}

                <FormField
                    control={form.control}
                    name="timestamp"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Date &amp; time</FormLabel>
                            <FormControl>
                                <Input
                                    type="datetime-local"
                                    value={field.value}
                                    onChange={field.onChange}
                                    className="tabular-nums"
                                />
                            </FormControl>
                            <FormDescription>
                                When the reading was taken — back-filling history is fine.
                            </FormDescription>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="notes"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Notes</FormLabel>
                            <FormControl>
                                <Textarea
                                    placeholder="Optional — e.g. morning, after meal, left arm…"
                                    rows={2}
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

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
                        {saving ? "Saving…" : log ? "Save reading" : "Log reading"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export interface MeasurementLogDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Reading being edited; null when creating. */
    log: MeasurementLog | null;
    types: MeasurementType[];
    /** Tracker preselected in create mode. */
    selectedType: MeasurementType | null;
    onSaved: (log: MeasurementLog, mode: "created" | "updated") => void;
}

export function MeasurementLogDialog({
                                         open,
                                         onOpenChange,
                                         log,
                                         types,
                                         selectedType,
                                         onSaved,
                                     }: MeasurementLogDialogProps) {
    const handleSaved = React.useCallback(
        (saved: MeasurementLog, mode: "created" | "updated") => {
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
                        {log ? "Edit reading" : "Log a reading"}
                    </DialogTitle>
                    <DialogDescription>
                        {log
                            ? "Adjust the tracker, value, time or notes."
                            : "Record what you measured — the time defaults to right now."}
                    </DialogDescription>
                </DialogHeader>

                {open && (
                    <MeasurementLogForm
                        key={log?.id ?? "create"}
                        log={log}
                        types={types}
                        selectedType={selectedType}
                        onSaved={handleSaved}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

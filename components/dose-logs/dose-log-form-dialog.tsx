"use client";

import * as React from "react";
import {useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {TriangleAlert} from "lucide-react";

import type {DoseLog, Medication, Schedule} from "@/lib/db/types";
import {DOSE_UNITS, medicationTypeMeta} from "@/lib/medications/constants";
import {CUSTOM_SITE, INJECTION_SITES, UNSPECIFIED_SITE} from "@/lib/scheduling/constants";
import {doseLogFormSchema, type DoseLogFormValues, doseLogToFormValues, toDoseLogInput,} from "@/lib/scheduling/schema";
import {logDose, updateDoseLog} from "@/lib/scheduling/service";

import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage} from "@/components/ui/form";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Separator} from "@/components/ui/separator";
import {Textarea} from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Form body (mounts fresh for every dialog session via a key)
// ---------------------------------------------------------------------------

interface DoseLogFormProps {
    log: DoseLog | null;
    medications: Medication[];
    schedules: Schedule[];
    onSaved: (log: DoseLog, mode: "created" | "updated") => void;
    onCancel: () => void;
}

function DoseLogForm({log, medications, schedules, onSaved, onCancel}: DoseLogFormProps) {
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const form = useForm<DoseLogFormValues>({
        resolver: zodResolver(doseLogFormSchema),
        defaultValues: doseLogToFormValues(log, medications, schedules),
    });

    const watched = useWatch({control: form.control});
    const siteSelection = watched.siteSelection ?? UNSPECIFIED_SITE;
    const selectedMedication = React.useMemo(
        () => medications.find((medication) => medication.id === (watched.medicationId ?? "")) ?? null,
        [medications, watched.medicationId]
    );

    const submit = async (values: DoseLogFormValues) => {
        setSaving(true);
        setError(null);
        try {
            const input = toDoseLogInput(values);
            let saved: DoseLog;
            if (log) {
                if (input.timestamp === undefined) {
                    // The form already rejects unparseable datetimes, so this is a
                    // type-honest guard for the edit path, not a reachable case.
                    throw new Error("Pick a date and time.");
                }
                // PUT semantics: only send the editable fields, and let an empty
                // optional field clear the stored value.
                saved = await updateDoseLog(log.id, {
                    medicationId: input.medicationId,
                    doseAmount: input.doseAmount,
                    unit: input.unit,
                    timestamp: input.timestamp,
                    injectionSite: input.injectionSite,
                    notes: input.notes,
                });
            } else {
                saved = await logDose(input);
            }
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
                    name="medicationId"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Medication</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                    <SelectTrigger className="w-full">
                                        <SelectValue placeholder="Choose a medication"/>
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    {medications.map((medication) => {
                                        const meta = medicationTypeMeta(medication.type);
                                        return (
                                            <SelectItem key={medication.id} value={medication.id}>
                                                <meta.icon className="size-4" aria-hidden/>
                                                {medication.name}
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                        control={form.control}
                        name="doseAmount"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Dose amount</FormLabel>
                                <div className="relative">
                                    <FormControl>
                                        <Input
                                            inputMode="decimal"
                                            placeholder="e.g. 1"
                                            className="pr-14 tabular-nums"
                                            {...field}
                                        />
                                    </FormControl>
                                    <span
                                        className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                        {watched.unit ?? "mg"}
                                    </span>
                                </div>
                                <FormDescription>
                                    Per administration{selectedMedication ? ` of ${selectedMedication.name}` : ""}.
                                </FormDescription>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="unit"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Dose unit</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value}>
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue/>
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
                </div>

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
                                When the dose was actually taken — past timestamps are fine for
                                back-filling history.
                            </FormDescription>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                <Separator/>

                <FormField
                    control={form.control}
                    name="siteSelection"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Injection site</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                    <SelectTrigger className="w-full">
                                        <SelectValue/>
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    <SelectItem value={UNSPECIFIED_SITE}>Not recorded</SelectItem>
                                    {INJECTION_SITES.map((site) => (
                                        <SelectItem key={site} value={site}>
                                            {site}
                                        </SelectItem>
                                    ))}
                                    <SelectItem value={CUSTOM_SITE}>Other…</SelectItem>
                                </SelectContent>
                            </Select>
                            <FormDescription>
                                Optional — leave “Not recorded” for oral or other non-injected doses.
                            </FormDescription>
                            <FormMessage/>
                        </FormItem>
                    )}
                />

                {siteSelection === CUSTOM_SITE && (
                    <FormField
                        control={form.control}
                        name="siteDetail"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Site (other)</FormLabel>
                                <FormControl>
                                    <Input
                                        placeholder="e.g. Left outer thigh"
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />
                )}

                <FormField
                    control={form.control}
                    name="notes"
                    render={({field}) => (
                        <FormItem>
                            <FormLabel>Notes</FormLabel>
                            <FormControl>
                                <Textarea
                                    placeholder="Optional — e.g. brand, batch, how it was tolerated…"
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
                        {saving
                            ? "Saving…"
                            : log
                                ? "Save dose"
                                : "Log dose"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export interface DoseLogFormDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Log being edited; null when creating. */
    log: DoseLog | null;
    medications: Medication[];
    schedules: Schedule[];
    onSaved: (log: DoseLog, mode: "created" | "updated") => void;
}

export function DoseLogFormDialog({
                                      open,
                                      onOpenChange,
                                      log,
                                      medications,
                                      schedules,
                                      onSaved,
                                  }: DoseLogFormDialogProps) {
    const handleSaved = React.useCallback(
        (saved: DoseLog, mode: "created" | "updated") => {
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
                        {log ? "Edit dose" : "Log a dose"}
                    </DialogTitle>
                    <DialogDescription>
                        {log
                            ? "Adjust the medication, amount, time, site or notes."
                            : "Record a dose you took — scheduled or a one-off, with the exact time."}
                    </DialogDescription>
                </DialogHeader>

                {open && (
                    <DoseLogForm
                        key={log?.id ?? "create"}
                        log={log}
                        medications={medications}
                        schedules={schedules}
                        onSaved={handleSaved}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

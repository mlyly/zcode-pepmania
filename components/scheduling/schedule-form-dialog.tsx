"use client";

import * as React from "react";
import {useForm, useWatch} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {CalendarClock, TriangleAlert} from "lucide-react";

import type {Medication, Schedule} from "@/lib/db/types";
import {DOSE_UNITS, doseUnitLabel, medicationTypeMeta} from "@/lib/medications/constants";
import {
    CUSTOM_SLOT,
    FREQUENCY_LABELS,
    FREQUENCY_TYPES,
    TIME_SLOTS,
    timeSlotFor,
    WEEKDAY_LABELS,
    WEEKDAYS,
} from "@/lib/scheduling/constants";
import {dateOnlyIso, formatRelativeDay} from "@/lib/scheduling/dates";
import {nextOccurrence, occurrenceScheduleSummary} from "@/lib/scheduling/occurrences";
import {
    scheduleFormSchema,
    type ScheduleFormValues,
    scheduleToFormValues,
    toScheduleInput,
} from "@/lib/scheduling/schema";
import {createSchedule, updateSchedule} from "@/lib/scheduling/service";
import {parseDecimalInput} from "@/lib/units";

import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage} from "@/components/ui/form";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Separator} from "@/components/ui/separator";
import {Switch} from "@/components/ui/switch";
import {cn} from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort schedule assembled from live (possibly incomplete) form values,
 * used only for the read-only preview line.
 */
function draftSchedule(values: ScheduleFormValues): Schedule {
    const rawTime = values.timeSlot === "custom" ? values.timeOfDay.trim() : "";
    const timeOfDay = /^\d{2}:\d{2}$/.test(rawTime)
        ? rawTime
        : (TIME_SLOTS.find((slot) => slot.id === values.timeSlot)?.defaultTime ??
            CUSTOM_SLOT.defaultTime);
    const rawStart = values.startDate.trim();
    return {
        id: "preview",
        medicationId: values.medicationId,
        doseAmount: parseDecimalInput(values.doseAmount) ?? 0,
        unit: values.unit,
        frequencyType: values.frequencyType,
        weekdays: WEEKDAYS.filter((_, index) => values.weekdays[index]),
        intervalDays: parseDecimalInput(values.intervalDays),
        timeOfDay,
        startDate: /^\d{4}-\d{2}-\d{2}$/.test(rawStart) ? rawStart : dateOnlyIso(new Date()),
        active: true,
    };
}

function previewLine(values: ScheduleFormValues): string {
    const draft = draftSchedule(values);
    const due = nextOccurrence(draft);
    if (!due) return "No occurrences will be generated with these settings.";
    const slot = timeSlotFor(draft.timeOfDay);
    return `First dose: ${formatRelativeDay(due)} · ${slot.label.toLowerCase()} (${draft.timeOfDay}) — ${occurrenceScheduleSummary(draft)}`;
}

// ---------------------------------------------------------------------------
// Form body (mounts fresh for every dialog session via a key)
// ---------------------------------------------------------------------------

interface ScheduleFormProps {
    schedule: Schedule | null;
    medications: Medication[];
    onSaved: (schedule: Schedule, mode: "created" | "updated") => void;
    onCancel: () => void;
}

function ScheduleForm({schedule, medications, onSaved, onCancel}: ScheduleFormProps) {
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const form = useForm<ScheduleFormValues>({
        resolver: zodResolver(scheduleFormSchema),
        defaultValues: scheduleToFormValues(schedule, schedule ? undefined : medications[0]),
    });

    const watched = useWatch({control: form.control});
    const frequencyType = watched.frequencyType ?? schedule?.frequencyType ?? "daily";
    const timeSlot = watched.timeSlot ?? "morning";
    const medicationId = watched.medicationId ?? "";
    const isWeekly = frequencyType === "weekly";
    const isCustom = frequencyType === "custom_interval";

    const selectedMedication = React.useMemo(
        () => medications.find((medication) => medication.id === medicationId) ?? null,
        [medications, medicationId]
    );

    const submit = async (values: ScheduleFormValues) => {
        setSaving(true);
        setError(null);
        try {
            const input = toScheduleInput(values);
            const saved = schedule
                ? await updateSchedule(schedule.id, input)
                : await createSchedule(input);
            onSaved(saved, schedule ? "updated" : "created");
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
                                        {doseUnitLabel(watched.unit ?? "mg")}
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

                <Separator/>

                {/* Frequency */}
                <fieldset className="flex flex-col gap-4">
                    <legend className="text-sm font-medium">Frequency</legend>

                    <FormField
                        control={form.control}
                        name="frequencyType"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>How often</FormLabel>
                                <FormControl>
                                    <div
                                        role="radiogroup"
                                        aria-label="Frequency"
                                        className="grid grid-cols-3 gap-1 rounded-lg border p-1"
                                    >
                                        {FREQUENCY_TYPES.map((type) => {
                                            const selected = field.value === type;
                                            return (
                                                <button
                                                    key={type}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    onClick={() => field.onChange(type)}
                                                    className={cn(
                                                        "tap rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                                                        selected
                                                            ? "bg-primary text-primary-foreground"
                                                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                                    )}
                                                >
                                                    {FREQUENCY_LABELS[type]}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </FormControl>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    {isWeekly && (
                        <FormField
                            control={form.control}
                            name="weekdays"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>On days</FormLabel>
                                    <FormControl>
                                        <div className="flex flex-wrap gap-1.5" role="group"
                                             aria-label="Days of the week">
                                            {WEEKDAYS.map((day) => {
                                                const selected = field.value[day];
                                                return (
                                                    <button
                                                        key={day}
                                                        type="button"
                                                        aria-pressed={selected}
                                                        onClick={() =>
                                                            field.onChange(
                                                                field.value.map((value, index) =>
                                                                    index === day ? !value : value
                                                                ),
                                                                {shouldValidate: true}
                                                            )
                                                        }
                                                        className={cn(
                                                            "tap h-8 w-9 rounded-md border text-xs font-medium tabular-nums transition-colors",
                                                            selected
                                                                ? "border-primary bg-primary text-primary-foreground"
                                                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                                        )}
                                                    >
                                                        {WEEKDAY_LABELS[day]}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </FormControl>
                                    <FormDescription>
                                        {field.value.filter(Boolean).length} of 7 days selected.
                                    </FormDescription>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    )}

                    {isCustom && (
                        <FormField
                            control={form.control}
                            name="intervalDays"
                            render={({field}) => (
                                <FormItem className="max-w-48">
                                    <FormLabel>Every N days</FormLabel>
                                    <div className="relative">
                                        <FormControl>
                                            <Input
                                                inputMode="numeric"
                                                placeholder="3"
                                                className="pr-12 tabular-nums"
                                                {...field}
                                            />
                                        </FormControl>
                                        <span
                                            className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                                            days
                                        </span>
                                    </div>
                                    <FormDescription>
                                        Counted from the start date — e.g. every 3 days, or 2 for
                                        alternating.
                                    </FormDescription>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                            control={form.control}
                            name="timeSlot"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>Time of day</FormLabel>
                                    <Select
                                        onValueChange={(value) => {
                                            field.onChange(value);
                                            // Snap the concrete time to the slot default.
                                            if (value !== "custom") {
                                                const slot = TIME_SLOTS.find((s) => s.id === value);
                                                if (slot) {
                                                    form.setValue("timeOfDay", slot.defaultTime, {
                                                        shouldValidate: true,
                                                    });
                                                }
                                            }
                                        }}
                                        value={field.value}
                                    >
                                        <FormControl>
                                            <SelectTrigger className="w-full">
                                                <SelectValue/>
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            {TIME_SLOTS.map((slot) => (
                                                <SelectItem key={slot.id} value={slot.id}>
                                                    {slot.label} ({slot.defaultTime})
                                                </SelectItem>
                                            ))}
                                            <SelectItem value="custom">Custom time</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="timeOfDay"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>
                                        Exact time{" "}
                                        {timeSlot !== "custom" && (
                                            <span className="text-muted-foreground font-normal">
                                                (edit to switch to custom)
                                            </span>
                                        )}
                                    </FormLabel>
                                    <FormControl>
                                        <Input
                                            type="time"
                                            value={field.value}
                                            onChange={(event) => {
                                                field.onChange(event.target.value);
                                                // A manually-typed time is by definition custom.
                                                if (timeSlot !== "custom") {
                                                    form.setValue("timeSlot", "custom", {
                                                        shouldValidate: false,
                                                    });
                                                }
                                            }}
                                            className="tabular-nums"
                                        />
                                    </FormControl>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    </div>
                </fieldset>

                <Separator/>

                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                        control={form.control}
                        name="startDate"
                        render={({field}) => (
                            <FormItem>
                                <FormLabel>Start date</FormLabel>
                                <FormControl>
                                    <Input
                                        type="date"
                                        value={field.value}
                                        onChange={field.onChange}
                                        className="tabular-nums"
                                    />
                                </FormControl>
                                <FormDescription>First day the schedule is due.</FormDescription>
                                <FormMessage/>
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="active"
                        render={({field}) => (
                            <FormItem
                                className="flex flex-row items-center justify-between rounded-lg border px-3 py-2.5">
                                <div className="min-w-0">
                                    <FormLabel className="text-sm">Active</FormLabel>
                                    <FormDescription className="text-xs">
                                        Paused schedules keep their history but stop generating
                                        doses.
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
                </div>

                {/* Live preview */}
                <p
                    className="text-muted-foreground bg-muted/30 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs"
                    aria-live="polite"
                >
                    <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden/>
                    {previewLine(watched as ScheduleFormValues)}
                </p>

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
                            : schedule
                                ? "Save schedule"
                                : "Create schedule"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export interface ScheduleFormDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Schedule being edited; null when creating. */
    schedule: Schedule | null;
    medications: Medication[];
    onSaved: (schedule: Schedule, mode: "created" | "updated") => void;
}

export function ScheduleFormDialog({
                                       open,
                                       onOpenChange,
                                       schedule,
                                       medications,
                                       onSaved,
                                   }: ScheduleFormDialogProps) {
    const handleSaved = React.useCallback(
        (saved: Schedule, mode: "created" | "updated") => {
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
                        {schedule ? "Edit schedule" : "New schedule"}
                    </DialogTitle>
                    <DialogDescription>
                        {schedule
                            ? "Change the dose, frequency, time or start date."
                            : "Pick a medication, how often to take it and when."}
                    </DialogDescription>
                </DialogHeader>

                {open && (
                    <ScheduleForm
                        key={schedule?.id ?? "create"}
                        schedule={schedule}
                        medications={medications}
                        onSaved={handleSaved}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

"use client";

import * as React from "react";
import Link from "next/link";
import {AlarmClock, CalendarPlus, Check, CheckCheck, Plus, Undo2,} from "lucide-react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Checkbox} from "@/components/ui/checkbox";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Progress} from "@/components/ui/progress";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import type {Medication} from "@/lib/db/types";
import {medicationTypeMeta} from "@/lib/medications/constants";
import {TIME_SLOTS, timeSlotFor, type TimeSlotMeta} from "@/lib/scheduling/constants";
import {formatClockTime, formatDay} from "@/lib/scheduling/dates";
import {dayOccurrences, matchingDoseLog, missedOccurrences, type Occurrence,} from "@/lib/scheduling/occurrences";
import {deleteDoseLog, logDose, logDoses} from "@/lib/scheduling/service";
import {formatAmount} from "@/lib/units";
import {cn} from "@/lib/utils";

import type {TrackerData} from "./use-tracker-data";

export interface ChecklistItem {
    occurrence: Occurrence & { status: "upcoming" | "due" | "overdue" | "done" };
    medication: Medication | null;
    /**
     * True when the completing log carries `scheduledFor` (created from this
     * checklist) and can be removed again; manually-logged doses can't be
     * un-logged from here.
     */
    canUndo: boolean;
}

export interface TodayChecklistProps {
    data: TrackerData;
    /** Called after any successful mutation (caller reloads its tables). */
    onChanged: () => void;
    /** Disables mutations while a write is in flight. */
    busy?: boolean;
    /**
     * Where the empty-state "manage" affordance goes: a route (dashboard
     * usage) or an action (in-page tab switch on /schedules).
     */
    manageHref?: string;
    onManage?: () => void;
}

/**
 * "Today's Doses" (AGENTS.md §5.1 Quick Log): one-tap check-off of every
 * active schedule's occurrence today, grouped by time-of-day slot, with
 * progress, overdue highlighting, make-up logging for the last 48 h and an
 * ad-hoc dose dialog.
 */
export function TodayChecklist({
                                   data,
                                   onChanged,
                                   busy = false,
                                   manageHref,
                                   onManage,
                               }: TodayChecklistProps) {
    const now = React.useMemo(() => new Date(), []); // stable per mount; reload re-renders
    const [actingKey, setActingKey] = React.useState<string | null>(null);
    const [adHocOpen, setAdHocOpen] = React.useState(false);

    const medications = React.useMemo(
        () => new Map(data.medications.map((m) => [m.id, m])),
        [data.medications]
    );

    const today = React.useMemo(() => {
        const occurrences = dayOccurrences(data.schedules, data.doseLogs, now, now);
        return occurrences.map((occurrence) => {
            const matched = matchingDoseLog(occurrence, data.doseLogs);
            return {
                occurrence: {
                    ...occurrence,
                    status: matched ? "done" : occurrence.status,
                },
                medication: medications.get(occurrence.medicationId) ?? null,
                canUndo: matched?.scheduledFor === occurrence.scheduledFor,
            } satisfies ChecklistItem;
        });
    }, [data.schedules, data.doseLogs, medications, now]);

    const missed = React.useMemo(
        () =>
            missedOccurrences(data.schedules, data.doseLogs, 48, now).map((occurrence) => ({
                occurrence,
                medication: medications.get(occurrence.medicationId) ?? null,
            })),
        [data.schedules, data.doseLogs, medications, now]
    );

    const doneCount = today.filter((item) => item.occurrence.status === "done").length;
    const overdueCount = today.filter((item) => item.occurrence.status === "overdue").length;

    // Slot buckets, in slot order; within a bucket, chronological.
    const buckets = React.useMemo(() => {
        const bySlot = new Map<string, ChecklistItem[]>();
        for (const item of today) {
            const slot = timeSlotFor(item.occurrence.timeOfDay);
            const list = bySlot.get(slot.id) ?? [];
            list.push(item);
            bySlot.set(slot.id, list);
        }
        return TIME_SLOTS.filter((slot) => bySlot.has(slot.id)).map((slot) => ({
            slot,
            items: (bySlot.get(slot.id) ?? [])
                .slice()
                .sort(
                    (a, b) =>
                        a.occurrence.scheduledAt.getTime() - b.occurrence.scheduledAt.getTime()
                ),
        }));
    }, [today]);

    const toggleItem = React.useCallback(
        async (item: ChecklistItem) => {
            const {occurrence} = item;
            const done = occurrence.status === "done";
            setActingKey(occurrence.key);
            try {
                if (done) {
                    if (!item.canUndo) return; // manual log — nothing to remove
                    const matched = matchingDoseLog(occurrence, data.doseLogs);
                    if (matched) await deleteDoseLog(matched.id);
                } else {
                    await logDose({
                        medicationId: occurrence.medicationId,
                        scheduleId: occurrence.scheduleId,
                        doseAmount: occurrence.doseAmount,
                        unit: occurrence.unit,
                        scheduledFor: occurrence.scheduledFor,
                    });
                }
                onChanged();
            } catch {
                // Surface via the manager's feedback; leave state untouched.
            } finally {
                setActingKey(null);
            }
        },
        [data.doseLogs, onChanged]
    );

    const logAll = React.useCallback(async () => {
        const pending = today.filter((item) => item.occurrence.status !== "done");
        if (pending.length === 0) return;
        setActingKey("__all__");
        try {
            await logDoses(
                pending.map((item) => ({
                    medicationId: item.occurrence.medicationId,
                    scheduleId: item.occurrence.scheduleId,
                    doseAmount: item.occurrence.doseAmount,
                    unit: item.occurrence.unit,
                    scheduledFor: item.occurrence.scheduledFor,
                }))
            );
            onChanged();
        } catch {
            // surfaced by the manager
        } finally {
            setActingKey(null);
        }
    }, [today, onChanged]);

    const logMissed = React.useCallback(
        async (item: { occurrence: WithStatus<Occurrence>; medication: Medication | null }) => {
            setActingKey(item.occurrence.key);
            try {
                await logDose({
                    medicationId: item.occurrence.medicationId,
                    scheduleId: item.occurrence.scheduleId,
                    doseAmount: item.occurrence.doseAmount,
                    unit: item.occurrence.unit,
                    scheduledFor: item.occurrence.scheduledFor,
                    notes: "Make-up dose",
                });
                onChanged();
            } catch {
                // surfaced by the manager
            } finally {
                setActingKey(null);
            }
        },
        [onChanged]
    );

    const pendingCount = today.length - doneCount;

    return (
        <Card>
            <CardHeader className="gap-1.5">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">Today’s doses</CardTitle>
                    <div className="flex items-center gap-2">
                        {pendingCount > 0 && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void logAll()}
                                disabled={busy || actingKey !== null}
                            >
                                <CheckCheck className="size-3.5" aria-hidden/>
                                Log all {pendingCount}
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setAdHocOpen(true)}
                            disabled={busy || data.medications.length === 0}
                        >
                            <Plus className="size-3.5" aria-hidden/>
                            Dose
                        </Button>
                    </div>
                </div>
                <p className="text-muted-foreground text-xs tabular-nums">
                    {formatDay(now)} · {doneCount} of {today.length} done
                    {overdueCount > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">
                            {" "}· {overdueCount} overdue
                        </span>
                    )}
                </p>
                <Progress
                    value={today.length > 0 ? (doneCount / today.length) * 100 : 0}
                    aria-label="Today's dose progress"
                    className="h-1.5"
                />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {today.length === 0 ? (
                    <EmptyState
                        hasMedications={data.medications.length > 0}
                        manageHref={manageHref}
                        onManage={onManage}
                    />
                ) : (
                    <>
                        {buckets.map(({slot, items}) => (
                            <section key={slot.id} className="flex flex-col gap-1.5">
                                <SlotHeader slot={slot}/>
                                <ul className="flex flex-col gap-1.5">
                                    {items.map((item) => (
                                        <ChecklistRow
                                            key={item.occurrence.key}
                                            item={item}
                                            busy={busy || actingKey === item.occurrence.key}
                                            onToggle={() => void toggleItem(item)}
                                        />
                                    ))}
                                </ul>
                            </section>
                        ))}

                        {missed.length > 0 && (
                            <section className="flex flex-col gap-1.5">
                                <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                                    <AlarmClock className="size-3.5" aria-hidden/>
                                    Missed in the last 48 h
                                </p>
                                <ul className="flex flex-col gap-1.5">
                                    {missed.map((item) => (
                                        <MissedRow
                                            key={item.occurrence.key}
                                            item={item}
                                            busy={busy || actingKey === item.occurrence.key}
                                            onLog={() => void logMissed(item)}
                                        />
                                    ))}
                                </ul>
                            </section>
                        )}
                    </>
                )}
            </CardContent>

            <AdHocDoseDialog
                open={adHocOpen}
                onOpenChange={setAdHocOpen}
                data={data}
                busy={busy}
                onLogged={onChanged}
            />
        </Card>
    );
}

type WithStatus<T> = T & { status: "upcoming" | "due" | "overdue" | "done" };

function SlotHeader({slot}: { slot: TimeSlotMeta }) {
    const Icon = slot.icon;
    return (
        <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
            <Icon className="size-3.5" aria-hidden/>
            {slot.label}
        </p>
    );
}

const STATUS_LINE: Record<
    ChecklistItem["occurrence"]["status"],
    { label: string; className: string }
> = {
    done: {label: "Done", className: "text-emerald-600 dark:text-emerald-400"},
    due: {label: "Due now", className: "text-sky-600 dark:text-sky-400"},
    overdue: {label: "Overdue", className: "text-amber-600 dark:text-amber-400"},
    upcoming: {label: "Scheduled", className: "text-muted-foreground"},
};

export interface ChecklistRowProps {
    item: ChecklistItem;
    busy: boolean;
    onToggle: () => void;
}

export function ChecklistRow({
                                 item,
                                 busy,
                                 onToggle,
                             }: ChecklistRowProps) {
    const {occurrence, medication} = item;
    const status = occurrence.status;
    const done = status === "done";
    const meta = medication ? medicationTypeMeta(medication.type) : null;

    return (
        <li
            className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                done && "bg-emerald-500/5 border-emerald-500/20",
                status === "overdue" && "border-amber-500/40 bg-amber-500/5",
                status === "upcoming" && "opacity-75"
            )}
        >
            <Checkbox
                checked={done}
                disabled={busy || (done && !item.canUndo)}
                onCheckedChange={onToggle}
                aria-label={`${medication?.name ?? "Dose"} — ${done ? "unlog" : "log"} ${formatClockTime(occurrence.scheduledAt)}`}
                className="size-5"
            />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-tight font-medium">
                    {medication?.name ?? "Unknown medication"}
                    <span className="text-muted-foreground font-normal">
                        {" "}
                        · {formatAmount(occurrence.doseAmount, occurrence.unit)}
                    </span>
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground tabular-nums">
                        {formatClockTime(occurrence.scheduledAt)}
                    </span>
                    <span className={cn("font-medium", STATUS_LINE[status].className)}>
                        {STATUS_LINE[status].label}
                    </span>
                </p>
            </div>
            {meta && (
                <span
                    className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-md border",
                        meta.badgeClass
                    )}
                    title={meta.label}
                >
                    <meta.icon className="size-3.5" aria-hidden/>
                </span>
            )}
            {done && item.canUndo && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-7"
                    onClick={onToggle}
                    disabled={busy}
                    aria-label={`Unlog ${medication?.name ?? "dose"}`}
                >
                    <Undo2 className="size-3.5" aria-hidden/>
                </Button>
            )}
            {done && !item.canUndo && (
                <span
                    className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"
                    title="Logged manually — open the dose history to change it"
                >
                    <Check className="size-3" aria-hidden/>
                    manual
                </span>
            )}
        </li>
    );
}

function MissedRow({
                       item,
                       busy,
                       onLog,
                   }: {
    item: { occurrence: WithStatus<Occurrence>; medication: Medication | null };
    busy: boolean;
    onLog: () => void;
}) {
    const meta = item.medication ? medicationTypeMeta(item.medication.type) : null;
    return (
        <li className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2">
            <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full">
                {meta ? <meta.icon className="size-3 text-muted-foreground" aria-hidden/> : null}
            </span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                    {item.medication?.name ?? "Unknown medication"}
                    <span className="text-muted-foreground">
                        {" "}
                        · {formatAmount(item.occurrence.doseAmount, item.occurrence.unit)}
                    </span>
                </p>
                <p className="text-muted-foreground text-xs tabular-nums">
                    {formatDay(item.occurrence.date)} · {formatClockTime(item.occurrence.scheduledAt)}
                    · not logged
                </p>
            </div>
            <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={onLog}
                disabled={busy}
            >
                <Plus className="size-3" aria-hidden/>
                Log
            </Button>
        </li>
    );
}

function EmptyState({
                        hasMedications,
                        manageHref,
                        onManage,
                    }: {
    hasMedications: boolean;
    manageHref?: string;
    onManage?: () => void;
}) {
    return (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="bg-muted rounded-full border p-3">
                <CalendarPlus className="text-muted-foreground size-6" aria-hidden/>
            </div>
            <div>
                <p className="text-sm font-medium">
                    {hasMedications ? "Nothing scheduled for today" : "No medications yet"}
                </p>
                <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                    {hasMedications
                        ? "Create a schedule to see its doses here — then check them off with one tap."
                        : "Add a medication and schedule its doses to start tracking."}
                </p>
            </div>
            {manageHref ? (
                <Button asChild size="sm" variant="outline">
                    <Link href={manageHref}>
                        <CalendarPlus className="size-3.5" aria-hidden/>
                        Manage schedules
                    </Link>
                </Button>
            ) : onManage ? (
                <Button size="sm" variant="outline" onClick={onManage}>
                    <CalendarPlus className="size-3.5" aria-hidden/>
                    Manage schedules
                </Button>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Ad-hoc dose dialog
// ---------------------------------------------------------------------------

interface AdHocDoseDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    data: TrackerData;
    busy: boolean;
    onLogged: () => void;
}

function localTimeNow(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * Dose prefill for a medication: the dose of its first active schedule (same
 * unit), else "1".
 */
function prefilledDose(
    medication: Medication | undefined,
    data: TrackerData
): string {
    if (!medication) return "1";
    const schedule = data.schedules.find(
        (s) => s.medicationId === medication.id && s.active
    );
    return schedule && schedule.unit === medication.unit
        ? schedule.doseAmount.toString()
        : "1";
}

interface AdHocDoseFormProps {
    data: TrackerData;
    busy: boolean;
    onLogged: () => void;
    onOpenChange: (open: boolean) => void;
}

/**
 * Form body — mounts fresh for every dialog session via a `key` in the shell,
 * so field defaults (first medication, its schedule dose, current time) are
 * computed at mount instead of through seeding effects.
 */
function AdHocDoseForm({data, busy, onLogged, onOpenChange}: AdHocDoseFormProps) {
    const first = data.medications[0];
    const [medicationId, setMedicationId] = React.useState(first?.id ?? "");
    const [amount, setAmount] = React.useState(() =>
        prefilledDose(first, data)
    );
    const [time, setTime] = React.useState(localTimeNow());
    const [notes, setNotes] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);

    const selected = data.medications.find((m) => m.id === medicationId);

    const selectMedication = (id: string) => {
        setMedicationId(id);
        const medication = data.medications.find((m) => m.id === id);
        setAmount(prefilledDose(medication, data));
    };

    const submit = async () => {
        const doseAmount = Number(amount.trim());
        if (!selected) {
            setError("Choose a medication.");
            return;
        }
        if (!Number.isFinite(doseAmount) || doseAmount <= 0) {
            setError("Enter a dose greater than zero.");
            return;
        }
        if (!/^\d{2}:\d{2}$/.test(time.trim())) {
            setError("Enter a valid time (HH:MM).");
            return;
        }
        setError(null);
        try {
            const [hour, minute] = time.trim().split(":").map(Number);
            const timestamp = new Date();
            timestamp.setHours(hour, minute, 0, 0);
            await logDose({
                medicationId: selected.id,
                doseAmount,
                unit: selected.unit,
                timestamp: timestamp.toISOString(),
                notes: notes.trim() || undefined,
            });
            onLogged();
            onOpenChange(false);
        } catch (submitError: unknown) {
            setError(submitError instanceof Error ? submitError.message : "Could not log the dose.");
        }
    };

    return (
        <>
            <div className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">Medication</span>
                        <Select value={medicationId} onValueChange={selectMedication}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Choose…"/>
                            </SelectTrigger>
                            <SelectContent>
                                {data.medications.map((medication) => (
                                    <SelectItem key={medication.id} value={medication.id}>
                                        {medication.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm">
                            <span className="font-medium">
                                Dose{" "}
                                <span className="text-muted-foreground">
                                    ({selected?.unit ?? "mg"})
                                </span>
                            </span>
                        <Input
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                            inputMode="decimal"
                            className="tabular-nums"
                            aria-label="Dose amount"
                        />
                    </label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">Time taken</span>
                        <Input
                            type="time"
                            value={time}
                            onChange={(event) => setTime(event.target.value)}
                            aria-label="Time of administration"
                        />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm">
                            <span className="font-medium">
                                Notes{" "}
                                <span className="text-muted-foreground">(optional)</span>
                            </span>
                        <Input
                            value={notes}
                            onChange={(event) => setNotes(event.target.value)}
                            placeholder="Felt fine, took with food…"
                            maxLength={2000}
                            aria-label="Notes"
                        />
                    </label>
                </div>
            </div>

            {error && (
                <p className="text-destructive text-sm" role="alert">
                    {error}
                </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={busy}
                >
                    Cancel
                </Button>
                <Button
                    onClick={() => void submit()}
                    disabled={busy || data.medications.length === 0}
                >
                    Log dose
                </Button>
            </div>
        </>
    );
}

function AdHocDoseDialog({open, onOpenChange, data, busy, onLogged}: AdHocDoseDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Log a dose</DialogTitle>
                    <DialogDescription>
                        Record an off-schedule dose. This does not change stock.
                    </DialogDescription>
                </DialogHeader>

                {/* Guarded by `open`: the form unmounts on close and remounts
                    fresh (default-filled) on each open — no seeding effects.
                    The key pins identity for React reconciliation. */}
                {open && (
                    <AdHocDoseForm
                        key="ad-hoc-dose-form"
                        data={data}
                        busy={busy}
                        onLogged={onLogged}
                        onOpenChange={onOpenChange}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

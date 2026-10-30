"use client";

import * as React from "react";
import {ChevronLeft, ChevronRight} from "lucide-react";

import type {MedicationType} from "@/lib/db/types";
import {addDays, dateOnlyIso, formatMonthYear, isSameLocalDay, startOfLocalDay,} from "@/lib/scheduling/dates";
import {matchingDoseLog, type Occurrence, rangeAgenda} from "@/lib/scheduling/occurrences";
import {deleteDoseLog, logDose} from "@/lib/scheduling/service";
import {cn} from "@/lib/utils";

import {Button} from "@/components/ui/button";
import {type ChecklistItem, ChecklistRow,} from "./today-checklist";
import type {TrackerData} from "./use-tracker-data";

type StatusedOccurrence = Occurrence & { status: "upcoming" | "due" | "overdue" | "done" };

/** Dot colors per medication type (calendar heat cells). */
const DOT_CLASS: Record<MedicationType, string> = {
    peptide: "bg-violet-500",
    injection: "bg-sky-500",
    pill: "bg-rose-500",
    liquid: "bg-cyan-500",
    supplement: "bg-amber-500",
    other: "bg-muted-foreground/50",
};

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ScheduleCalendarProps {
    data: TrackerData;
    /** Local calendar day currently selected (controlled by the parent). */
    selectedDate: Date;
    onSelectDate: (date: Date) => void;
    /** Called after a log/un-log mutation. */
    onChanged: () => void;
    /** Called when a mutation fails (the manager shows the feedback line). */
    onError?: (error: unknown, prefix: string) => void;
    busy?: boolean;
}

/**
 * Month grid + day agenda: the calendar/agenda view of the scheduling module.
 *
 * Each day cell shows one dot per medication with doses that day; selecting a
 * day reveals its agenda below, where occurrences can be checked off (logging
 * them) or un-checked (undoing checklist-created logs) — past days included,
 * which doubles as the make-up flow.
 */
export function ScheduleCalendar({
                                     data,
                                     selectedDate,
                                     onSelectDate,
                                     onChanged,
                                     onError,
                                     busy = false,
                                 }: ScheduleCalendarProps) {
    const now = React.useMemo(() => new Date(), []);
    const medications = React.useMemo(
        () => new Map(data.medications.map((m) => [m.id, m])),
        [data.medications]
    );
    const [actingKey, setActingKey] = React.useState<string | null>(null);

    const viewYear = selectedDate.getFullYear();
    const viewMonth = selectedDate.getMonth();
    const monthStart = new Date(viewYear, viewMonth, 1);
    // Anchor the 6×7 grid to the Sunday on/before the 1st.
    const gridStart = addDays(monthStart, -monthStart.getDay());
    const gridEnd = addDays(gridStart, 41);

    const cells = React.useMemo(
        () => Array.from({length: 42}, (_, index) => addDays(gridStart, index)),
        [gridStart]
    );

    // Occurrences across the whole visible grid, keyed by calendar day.
    const occurrencesByDay = React.useMemo(() => {
        const list = rangeAgenda(data.schedules, data.doseLogs, gridStart, gridEnd, now);
        const byDay = new Map<string, StatusedOccurrence[]>();
        for (const occurrence of list) {
            const bucket = byDay.get(occurrence.dateIso) ?? [];
            bucket.push(occurrence as StatusedOccurrence);
            byDay.set(occurrence.dateIso, bucket);
        }
        return byDay;
    }, [data.schedules, data.doseLogs, gridStart, gridEnd, now]);

    const selectedDay = React.useMemo(() => startOfLocalDay(selectedDate), [selectedDate]);
    const selectedOccurrences = React.useMemo(
        () => occurrencesByDay.get(dateOnlyIso(selectedDay)) ?? [],
        [occurrencesByDay, selectedDay]
    );

    const agendaItems = React.useMemo(
        () =>
            selectedOccurrences.map((occurrence): ChecklistItem => {
                const matched = matchingDoseLog(occurrence, data.doseLogs);
                return {
                    occurrence: {...occurrence, status: matched ? "done" : occurrence.status},
                    medication: medications.get(occurrence.medicationId) ?? null,
                    canUndo: matched?.scheduledFor === occurrence.scheduledFor,
                };
            }),
        [selectedOccurrences, data.doseLogs, medications]
    );

    const toggleItem = React.useCallback(
        async (item: ChecklistItem) => {
            const {occurrence} = item;
            const done = occurrence.status === "done";
            setActingKey(occurrence.key);
            try {
                if (done) {
                    if (!item.canUndo) return;
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
            } catch (error: unknown) {
                onError?.(error, "Could not update the dose log");
            } finally {
                setActingKey(null);
            }
        },
        [data.doseLogs, onChanged, onError]
    );

    const moveMonth = (delta: number) => {
        onSelectDate(new Date(viewYear, viewMonth + delta, 1));
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Month navigation */}
            <div className="flex items-center justify-between">
                <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => moveMonth(-1)}
                    aria-label="Previous month"
                >
                    <ChevronLeft className="size-4" aria-hidden/>
                </Button>
                <h2 className="text-sm font-semibold tabular-nums">
                    {formatMonthYear(selectedDate)}
                </h2>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSelectDate(now)}
                        className="h-8"
                    >
                        Today
                    </Button>
                    <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        onClick={() => moveMonth(1)}
                        aria-label="Next month"
                    >
                        <ChevronRight className="size-4" aria-hidden/>
                    </Button>
                </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-7 gap-1">
                {WEEKDAY_HEADERS.map((label) => (
                    <div
                        key={label}
                        className="text-muted-foreground text-center text-[11px] font-medium"
                    >
                        {label}
                    </div>
                ))}
                {cells.map((day) => {
                    const iso = dateOnlyIso(day);
                    const inMonth = day.getMonth() === viewMonth;
                    const isToday = isSameLocalDay(day, now);
                    const isSelected = isSameLocalDay(day, selectedDate);
                    const dayOccurrences = occurrencesByDay.get(iso) ?? [];
                    const visible = dayOccurrences.slice(0, 3);
                    const overflow = dayOccurrences.length - visible.length;
                    return (
                        <button
                            key={iso}
                            type="button"
                            onClick={() => onSelectDate(day)}
                            aria-pressed={isSelected}
                            aria-label={`${formatMonthYear(day)} ${day.getDate()}, ${
                                dayOccurrences.length
                            } dose${dayOccurrences.length === 1 ? "" : "s"}`}
                            className={cn(
                                "relative flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs tabular-nums transition-colors sm:h-14",
                                !inMonth && "text-muted-foreground/50",
                                isSelected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "hover:bg-accent",
                                isToday && !isSelected && "border-ring font-semibold"
                            )}
                        >
                            <span>{day.getDate()}</span>
                            {dayOccurrences.length > 0 && (
                                <span className="flex items-center gap-0.5">
                                    {visible.map((occurrence) => {
                                        const medication = medications.get(
                                            occurrence.medicationId
                                        );
                                        const done = occurrence.status === "done";
                                        const type = medication?.type ?? "other";
                                        return (
                                            <span
                                                key={occurrence.key}
                                                className={cn(
                                                    "size-1.5 rounded-full",
                                                    DOT_CLASS[type],
                                                    !inMonth && "opacity-60",
                                                    done && "opacity-40",
                                                    isSelected && "bg-primary-foreground/90"
                                                )}
                                            />
                                        );
                                    })}
                                    {overflow > 0 && (
                                        <span className="text-[9px] leading-none">+{overflow}</span>
                                    )}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Agenda for the selected day */}
            <section className="flex flex-col gap-2">
                <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                    <span className="text-foreground text-xs font-semibold normal-case">
                        {selectedOccurrences.length}
                    </span>
                    dose{selectedOccurrences.length === 1 ? "" : "s"} ·{" "}
                    {selectedDate.toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                    })}
                </p>
                {selectedOccurrences.length === 0 ? (
                    <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
                        Nothing scheduled for this day.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1.5">
                        {agendaItems.map((item) => (
                            <ChecklistRow
                                key={item.occurrence.key}
                                item={item}
                                busy={busy || actingKey === item.occurrence.key}
                                onToggle={() => void toggleItem(item)}
                            />
                        ))}
                    </ul>
                )}
                {selectedDate < startOfLocalDay(now) && (
                    <p className="text-muted-foreground text-xs">
                        Tip: checking off a past dose logs it now as a make-up — this is how you
                        catch up on missed doses.
                    </p>
                )}
            </section>
        </div>
    );
}

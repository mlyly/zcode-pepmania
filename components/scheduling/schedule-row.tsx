"use client";

import * as React from "react";
import {CalendarClock, MoreHorizontal, Pencil, Trash2,} from "lucide-react";

import type {Medication, Schedule} from "@/lib/db/types";
import {medicationTypeMeta} from "@/lib/medications/constants";
import {timeSlotFor} from "@/lib/scheduling/constants";
import {formatRelativeDay} from "@/lib/scheduling/dates";
import {nextOccurrence, occurrenceScheduleSummary,} from "@/lib/scheduling/occurrences";
import {formatAmount} from "@/lib/units";
import {cn} from "@/lib/utils";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card} from "@/components/ui/card";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from "@/components/ui/dropdown-menu";
import {Switch} from "@/components/ui/switch";

export interface ScheduleRowProps {
    schedule: Schedule;
    /** The medication this schedule belongs to (null when it was deleted). */
    medication: Medication | null;
    onEdit: (schedule: Schedule) => void;
    onDelete: (schedule: Schedule) => void;
    onToggleActive: (schedule: Schedule, active: boolean) => void;
    /** Disables mutations while a write is in flight for this row. */
    busy?: boolean;
}

/** One schedule in the "Schedules" list: cadence, next dose and quick actions. */
export function ScheduleRow({
                                schedule,
                                medication,
                                onEdit,
                                onDelete,
                                onToggleActive,
                                busy = false,
                            }: ScheduleRowProps) {
    const meta = medication ? medicationTypeMeta(medication.type) : null;
    const slot = timeSlotFor(schedule.timeOfDay);
    const next = React.useMemo(() => nextOccurrence(schedule), [schedule]);
    const paused = !schedule.active;

    return (
        <Card className={cn("gap-3 py-4", paused && "opacity-70")}>
            <div className="flex items-start justify-between gap-2 px-4">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span
                        className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-md border",
                            meta?.badgeClass ?? "border-border bg-muted text-muted-foreground"
                        )}
                    >
                        {meta ? (
                            <meta.icon className="size-4" aria-hidden/>
                        ) : (
                            <CalendarClock className="size-4" aria-hidden/>
                        )}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate text-sm leading-tight font-semibold">
                            {medication?.name ?? "Unknown medication"}
                            <span className="text-muted-foreground font-normal">
                                {" "}
                                · {formatAmount(schedule.doseAmount, schedule.unit)}
                            </span>
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                                {occurrenceScheduleSummary(schedule)}
                            </Badge>
                            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
                                <slot.icon className="size-3 shrink-0" aria-hidden/>
                                {slot.label}
                            </span>
                            {!paused && next && (
                                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                                    <CalendarClock className="size-3 shrink-0" aria-hidden/>
                                    next {formatRelativeDay(next)}
                                </span>
                            )}
                            {paused && (
                                <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                                    Paused
                                </Badge>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                        checked={schedule.active}
                        onCheckedChange={(active) => onToggleActive(schedule, active)}
                        disabled={busy}
                        aria-label={
                            schedule.active
                                ? `Pause ${medication?.name ?? "schedule"}`
                                : `Resume ${medication?.name ?? "schedule"}`
                        }
                    />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Actions for ${medication?.name ?? "schedule"}`}
                                disabled={busy}
                            >
                                <MoreHorizontal className="size-4" aria-hidden/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => onEdit(schedule)}>
                                <Pencil className="size-4" aria-hidden/>
                                Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => onDelete(schedule)}
                            >
                                <Trash2 className="size-4" aria-hidden/>
                                Delete…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </Card>
    );
}

"use client";

import * as React from "react";
import {CalendarCheck2, ClipboardList, MapPin, MoreHorizontal, Pencil, Trash2,} from "lucide-react";

import type {DoseLog, Medication} from "@/lib/db/types";
import {medicationTypeMeta} from "@/lib/medications/constants";
import {formatClockTime} from "@/lib/scheduling/dates";
import {formatAmount} from "@/lib/units";
import {cn} from "@/lib/utils";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card} from "@/components/ui/card";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from "@/components/ui/dropdown-menu";

export interface DoseLogRowProps {
    log: DoseLog;
    /** The medication this log references (null when it was deleted). */
    medication: Medication | null;
    onEdit: (log: DoseLog) => void;
    onDelete: (log: DoseLog) => void;
    /** Disables actions while a write is in flight for this row. */
    busy?: boolean;
}

/**
 * One dose in the day-grouped history: what, how much, when, where (site)
 * and quick actions. Mirrors the visual language of `ScheduleRow`.
 */
export function DoseLogRow({
                               log,
                               medication,
                               onEdit,
                               onDelete,
                               busy = false,
                           }: DoseLogRowProps) {
    const meta = medication ? medicationTypeMeta(medication.type) : null;
    const time = React.useMemo(() => new Date(log.timestamp), [log.timestamp]);
    const fromSchedule = log.scheduleId !== undefined;

    return (
        <Card className="gap-2 py-3">
            <div className="flex items-center justify-between gap-2 px-4">
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
                            <ClipboardList className="size-4" aria-hidden/>
                        )}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate text-sm leading-tight font-semibold">
                            {medication?.name ?? "Unknown medication"}
                            <span className="text-muted-foreground font-normal">
                                {" "}
                                · {formatAmount(log.doseAmount, log.unit)}
                            </span>
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
                                <CalendarCheck2 className="size-3 shrink-0" aria-hidden/>
                                {formatClockTime(time)}
                            </span>
                            {log.injectionSite && (
                                <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                                    <MapPin className="mr-1 size-3" aria-hidden/>
                                    {log.injectionSite}
                                </Badge>
                            )}
                            {fromSchedule && (
                                <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                                    From schedule
                                </Badge>
                            )}
                            {log.notes && (
                                <span className="text-muted-foreground max-w-52 truncate text-xs">
                                    {log.notes}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Actions for ${medication?.name ?? "this dose"}`}
                                disabled={busy}
                            >
                                <MoreHorizontal className="size-4" aria-hidden/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => onEdit(log)}>
                                <Pencil className="size-4" aria-hidden/>
                                Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => onDelete(log)}
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

"use client";

import * as React from "react";
import {MoreHorizontal, NotebookPen, Pencil, Trash2} from "lucide-react";

import type {MeasurementLog, MeasurementType} from "@/lib/db/types";
import {effectiveKind, formatStoredValue} from "@/lib/measurements/derived";
import {formatClockTime} from "@/lib/scheduling/dates";

import {Button} from "@/components/ui/button";
import {Card} from "@/components/ui/card";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from "@/components/ui/dropdown-menu";

export interface MeasurementLogRowProps {
    log: MeasurementLog;
    /** The tracker this reading belongs to (null when it was deleted). */
    type: MeasurementType | null;
    onEdit: (log: MeasurementLog) => void;
    onDelete: (log: MeasurementLog) => void;
    /** Disables actions while a write is in flight for this row. */
    busy?: boolean;
}

/**
 * One reading in the day-grouped history: value, clock time, notes and quick
 * actions. Mirrors the visual language of `DoseLogRow`, trimmed tighter since
 * body-metric rows are mostly number + time.
 */
export function MeasurementLogRow({
                                      log,
                                      type,
                                      onEdit,
                                      onDelete,
                                      busy = false,
                                  }: MeasurementLogRowProps) {
    const time = React.useMemo(() => new Date(log.timestamp), [log.timestamp]);
    const valueText = formatStoredValue(log.value, effectiveKind(type), type?.unit ?? "");

    return (
        <Card className="gap-2 py-2.5">
            <div className="flex items-center justify-between gap-2 px-4">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="min-w-0">
                        <span className="text-sm leading-tight font-semibold tabular-nums">
                            {valueText || type?.name || "Reading"}
                        </span>
                        <span
                            className="text-muted-foreground ml-2 inline-flex items-center gap-1 text-xs tabular-nums">
                            <NotebookPen className="size-3 shrink-0" aria-hidden/>
                            {formatClockTime(time)}
                        </span>
                        {log.notes && (
                            <span className="text-muted-foreground ml-2 max-w-64 truncate text-xs">
                                {log.notes}
                            </span>
                        )}
                    </span>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Actions for ${valueText || "this reading"}`}
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

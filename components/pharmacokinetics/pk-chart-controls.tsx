"use client";

import * as React from "react";
import {Check, Eye, EyeOff, SlidersHorizontal} from "lucide-react";

import type {Medication} from "@/lib/db/types";
import {
    CHART_RANGES,
    type ChartRangeId,
    CONCENTRATION_UNIT_META,
    CONCENTRATION_UNITS,
    type ConcentrationDisplayUnit,
} from "@/lib/pharmacokinetics/charting";
import {cn} from "@/lib/utils";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";

export interface PkChartControlsProps {
    rangeId: ChartRangeId;
    onRangeChange: (id: ChartRangeId) => void;
    unit: ConcentrationDisplayUnit;
    onUnitChange: (unit: ConcentrationDisplayUnit) => void;
    medications: Medication[];
    /** Medications with a usable half-life; others are shown disabled. */
    availableIds: ReadonlySet<string>;
    selectedIds: ReadonlySet<string>;
    colorById: ReadonlyMap<string, string>;
    onToggleMedication: (medicationId: string) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
}

/**
 * Dashboard control surface: calendar window, display unit and the
 * multi-select medication filter. All controls are plain buttons so the whole
 * panel works with keyboard and screen readers without a popover.
 */
export function PkChartControls({
                                    rangeId,
                                    onRangeChange,
                                    unit,
                                    onUnitChange,
                                    medications,
                                    availableIds,
                                    selectedIds,
                                    colorById,
                                    onToggleMedication,
                                    onSelectAll,
                                    onClearSelection,
                                }: PkChartControlsProps) {
    const availableCount = medications.filter((m) => availableIds.has(m.id)).length;
    const selectedCount = medications.filter(
        (m) => availableIds.has(m.id) && selectedIds.has(m.id)
    ).length;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
                        <SlidersHorizontal className="size-3.5" aria-hidden/>
                        Time range
                    </span>
                    <div
                        role="group"
                        aria-label="Time range"
                        className="bg-muted/50 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border p-1"
                    >
                        {CHART_RANGES.map((range) => {
                            const active = range.id === rangeId;
                            return (
                                <Button
                                    key={range.id}
                                    type="button"
                                    size="sm"
                                    variant={active ? "default" : "ghost"}
                                    aria-pressed={active}
                                    onClick={() => onRangeChange(range.id)}
                                    className={cn(
                                        "h-7 shrink-0 px-2.5 text-xs",
                                        !active && "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {range.label}
                                </Button>
                            );
                        })}
                    </div>
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-muted-foreground text-xs font-medium">
                        Display unit
                    </span>
                    <div
                        role="group"
                        aria-label="Display unit"
                        className="bg-muted/50 flex w-fit gap-1 rounded-lg border p-1"
                    >
                        {CONCENTRATION_UNITS.map((option) => {
                            const active = option === unit;
                            const meta = CONCENTRATION_UNIT_META[option];
                            return (
                                <Button
                                    key={option}
                                    type="button"
                                    size="sm"
                                    variant={active ? "default" : "ghost"}
                                    aria-pressed={active}
                                    title={meta.description}
                                    onClick={() => onUnitChange(option)}
                                    className={cn(
                                        "h-7 px-3 text-xs tabular-nums",
                                        !active && "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {meta.label}
                                </Button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground text-xs font-medium">
                            Medications
                        </span>
                        <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                            {selectedCount} of {availableCount} shown
                        </Badge>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={onSelectAll}
                            disabled={availableCount === 0 || selectedCount === availableCount}
                        >
                            <Eye className="size-3.5" aria-hidden/>
                            All
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={onClearSelection}
                            disabled={selectedCount === 0}
                        >
                            <EyeOff className="size-3.5" aria-hidden/>
                            None
                        </Button>
                    </div>
                </div>

                {medications.length === 0 ? (
                    <p className="text-muted-foreground mt-3 text-xs">
                        No medications yet. Add one with a half-life to plot a curve.
                    </p>
                ) : (
                    <div
                        role="group"
                        aria-label="Medication filters"
                        className="mt-3 flex flex-wrap gap-1.5"
                    >
                        {medications.map((medication) => {
                            const available = availableIds.has(medication.id);
                            const selected = available && selectedIds.has(medication.id);
                            const color = colorById.get(medication.id) ?? "var(--chart-1)";
                            return (
                                <button
                                    key={medication.id}
                                    type="button"
                                    aria-pressed={selected}
                                    disabled={!available}
                                    title={
                                        available
                                            ? `Toggle ${medication.name} on the chart`
                                            : `${medication.name} needs a half-life before it can be plotted.`
                                    }
                                    onClick={() => onToggleMedication(medication.id)}
                                    className={cn(
                                        "tap inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                                        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                                        selected
                                            ? "bg-accent text-foreground shadow-xs"
                                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                                        !available && "cursor-not-allowed opacity-50 hover:bg-transparent"
                                    )}
                                    style={selected ? {borderColor: color} : undefined}
                                >
                                    <span
                                        className="size-2 shrink-0 rounded-full"
                                        style={{
                                            backgroundColor: available ? color : "var(--muted-foreground)",
                                        }}
                                        aria-hidden
                                    />
                                    <span className="max-w-40 truncate">{medication.name}</span>
                                    {selected && <Check className="size-3 shrink-0" aria-hidden/>}
                                    {!available && (
                                        <span className="text-muted-foreground text-[10px]">
                                            no t½
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {unit === "IU" && (
                    <p className="text-muted-foreground mt-2 text-[11px]">
                        IU uses the app&apos;s 1:1 mg fallback — verify your product&apos;s
                        IU-per-mg if precision matters.
                    </p>
                )}
            </div>
        </div>
    );
}

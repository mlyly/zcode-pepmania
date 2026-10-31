"use client";

import * as React from "react";
import {CalendarClock, FlaskConical, TriangleAlert} from "lucide-react";

import type {DoseUnit, Medication, Schedule} from "@/lib/db/types";
import {concentrationLabel, dosesPerVial, scheduleFrequencyLabel,} from "@/lib/medications/derived";
import {formatAmount, formatNumber, IU_FALLBACK_WARNING} from "@/lib/units";
import {cn} from "@/lib/utils";

import {DoseReadout} from "./dose-readout";

// ---------------------------------------------------------------------------
// Concentration summary
// ---------------------------------------------------------------------------

interface ConcentrationSummaryProps {
    /** Reconstitution + dose unit; may be a synthesized preview from the form. */
    medication: Pick<Medication, "reconstitution" | "unit"> | null;
    /** Reference dose (usually the first active schedule) for the per-vial hint. */
    referenceDose?: { amount: number; unit: DoseUnit } | null;
    className?: string;
}

/** Live concentration readout for a reconstituted vial (AGENTS.md §4.3). */
export function ConcentrationSummary({
                                         medication,
                                         referenceDose,
                                         className,
                                     }: ConcentrationSummaryProps) {
    const label = medication ? concentrationLabel(medication) : null;

    const perVial = React.useMemo(() => {
        if (!medication || !referenceDose || referenceDose.amount <= 0) return null;
        return dosesPerVial(referenceDose.amount, referenceDose.unit, medication);
    }, [medication, referenceDose]);

    if (!medication || !label) {
        return (
            <p className="text-muted-foreground text-xs">
                Enter a vial quantity and BAC water to see the concentration.
            </p>
        );
    }

    return (
        <div
            className={cn(
                "bg-muted/30 flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-xs",
                className
            )}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex items-center gap-1.5 font-medium">
                    <FlaskConical className="size-3.5" aria-hidden/>
                    {label.primary}
                </span>
                {label.secondary && (
                    <span className="text-muted-foreground">= {label.secondary}</span>
                )}
            </div>
            {perVial !== null && referenceDose && perVial > 0 && (
                <p className="text-muted-foreground">
                    One vial ≈ {formatNumber(perVial)} ×{" "}
                    {formatAmount(referenceDose.amount, referenceDose.unit)} doses
                </p>
            )}
            {perVial === 0 && referenceDose && (
                <p className="text-amber-600 dark:text-amber-400">
                    A single dose exceeds one vial — check the amounts.
                </p>
            )}
            {label.iuFallback && (
                <p className="text-amber-600 dark:text-amber-400 inline-flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden/>
                    {IU_FALLBACK_WARNING}
                </p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Schedule-linked dose volumes
// ---------------------------------------------------------------------------

interface ScheduleVolumeListProps {
    medication: Medication;
    /** Active schedules for this medication (pass pre-filtered). */
    schedules: Schedule[];
    className?: string;
}

/**
 * Active schedules linked to a medication, each with the computed injection
 * volume and a U-100 syringe visual when reconstitution data exists.
 */
export function ScheduleVolumeList({
                                       medication,
                                       schedules,
                                       className,
                                   }: ScheduleVolumeListProps) {
    if (schedules.length === 0) return null;
    return (
        <div className={cn("flex flex-col gap-1.5", className)}>
            {schedules.map((schedule) => (
                <div
                    key={schedule.id}
                    className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                >
                    <DoseReadout
                        amount={schedule.doseAmount}
                        unit={schedule.unit}
                        medication={medication}
                        variant="syringe"
                    />
                    <span className="min-w-0 truncate">
                        {scheduleFrequencyLabel(schedule)} · {schedule.timeOfDay}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** Section wrapper used by the card and the edit dialog. */
export function ScheduleSection({
                                    medication,
                                    schedules,
                                }: {
    medication: Medication;
    schedules: Schedule[];
}) {
    if (schedules.length === 0) return null;
    return (
        <div className="bg-muted/20 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
            <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                <CalendarClock className="size-3.5" aria-hidden/>
                {schedules.length} active {schedules.length === 1 ? "schedule" : "schedules"}
            </p>
            <ScheduleVolumeList medication={medication} schedules={schedules}/>
        </div>
    );
}

"use client";

import type {DoseUnit, Medication} from "@/lib/db/types";
import {doseVolumeMl} from "@/lib/medications/derived";
import {formatAmount, formatNumber, mlToSyringeUnits} from "@/lib/units";
import {cn} from "@/lib/utils";

import {SyringeMeter} from "./syringe-meter";

export interface DoseReadoutProps {
    amount: number;
    unit: DoseUnit;
    /** Medication supplying the reconstitution; null when it was deleted. */
    medication: Pick<Medication, "reconstitution" | "unit"> | null;
    /**
     * `inline` renders "2.5 mg · 0.25 mL · 25 U"; `syringe` pairs the amount
     * with the compact U-100 syringe visual.
     */
    variant?: "inline" | "syringe";
    /** Hide the amount when the caller already shows it elsewhere. */
    showAmount?: boolean;
    className?: string;
}

/**
 * Single source of truth for scheduled-dose amounts across the app: the
 * prescribed dose in its mass unit plus the injection volume / U-100 units
 * derived from the medication's reconstitution (AGENTS.md §4.3).
 */
export function DoseReadout({
                                amount,
                                unit,
                                medication,
                                variant = "inline",
                                showAmount = true,
                                className,
                            }: DoseReadoutProps) {
    const volume = medication ? doseVolumeMl(amount, unit, medication) : null;
    const amountLabel = formatAmount(amount, unit);
    // An mL dose already is the volume; don't repeat "0.2 mL · 0.2 mL · 20 U".
    const showAmountLabel = showAmount && unit !== "mL";

    if (volume === null) {
        if (!showAmount) return null;
        return (
            <span className={cn("tabular-nums", className)}>
                {amountLabel}
            </span>
        );
    }

    if (variant === "syringe") {
        return (
            <span
                className={cn(
                    "inline-flex flex-wrap items-center gap-x-2 gap-y-1",
                    className
                )}
            >
                {showAmountLabel && (
                    <span className="text-foreground font-medium tabular-nums">
                        {amountLabel}
                    </span>
                )}
                <SyringeMeter ml={volume}/>
            </span>
        );
    }

    return (
        <span className={cn("tabular-nums", className)}>
            {showAmountLabel && (
                <>
                    <span className="text-foreground font-medium">{amountLabel}</span>
                    <span className="text-muted-foreground/70">{" · "}</span>
                </>
            )}
            <span className="text-muted-foreground">
                {formatNumber(volume)} mL · {formatNumber(mlToSyringeUnits(volume))} U
            </span>
        </span>
    );
}

"use client";

import {cn} from "@/lib/utils";
import {formatNumber, mlToSyringeUnits} from "@/lib/units";

interface SyringeMeterProps {
    /** Dose volume to visualize. */
    ml: number;
    /** Syringe capacity in mL (default 1 mL = 100 units, U-100). */
    capacityMl?: number;
    className?: string;
}

/**
 * Compact U-100 syringe visual: a tick-marked barrel with a plunger marker,
 * plus the equivalent volume/units readout. Doses above capacity pin the
 * marker and switch to a warning tint.
 */
export function SyringeMeter({ml, capacityMl = 1, className}: SyringeMeterProps) {
    const units = mlToSyringeUnits(ml);
    const overCapacity = ml > capacityMl;
    const ratio = Math.min(1, Math.max(0, ml / capacityMl));
    const label = `${formatNumber(ml)} mL · ${formatNumber(units)} U`;

    return (
        <span
            role="img"
            aria-label={`Injection volume ${label} on a U-100 syringe`}
            className={cn("inline-flex shrink-0 items-center gap-2", className)}
        >
            <span
                aria-hidden
                className="bg-muted/70 border relative block h-3 w-20 overflow-hidden rounded-[3px] sm:w-24"
            >
                {/* unit ticks every 10 marks, heavier at 50% */}
                {Array.from({length: 9}, (_, i) => (i + 1) * 10).map((mark) => (
                    <span
                        key={mark}
                        className={cn(
                            "absolute inset-y-0.5 w-px",
                            mark === 50 ? "bg-border" : "bg-border/60"
                        )}
                        style={{left: `${mark}%`}}
                    />
                ))}
                <span
                    className={cn(
                        "absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full",
                        overCapacity
                            ? "bg-amber-500 dark:bg-amber-400"
                            : "bg-primary dark:bg-primary"
                    )}
                    style={{left: `${ratio * 100}%`}}
                />
            </span>
            <span
                className={cn(
                    "text-muted-foreground tabular-nums text-xs whitespace-nowrap",
                    overCapacity && "text-amber-600 dark:text-amber-400"
                )}
            >
                {label}
                {overCapacity ? " > 1 mL" : ""}
            </span>
        </span>
    );
}

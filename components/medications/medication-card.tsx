"use client";

import * as React from "react";
import {
    CalendarClock,
    ExternalLink,
    FlaskConical,
    Minus,
    MoreHorizontal,
    Pencil,
    Plus,
    Timer,
    Trash2,
    TriangleAlert,
} from "lucide-react";

import type {Medication, Schedule} from "@/lib/db/types";
import {
    activeSchedulesFor,
    concentrationLabel,
    daysOfStockRemaining,
    formatStockDuration,
    inventoryPriceTotals,
    inventoryStatus,
    inventoryTotals,
    lotTotalAmount,
    lotTotalPrice,
    stockRatio,
} from "@/lib/medications/derived";
import {medicationTypeMeta} from "@/lib/medications/constants";
import {formatAmount, formatNumber, formatPrice} from "@/lib/units";
import {cn} from "@/lib/utils";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from "@/components/ui/dropdown-menu";
import {Progress} from "@/components/ui/progress";
import {ScheduleSection} from "./reconstitution-panel";

export interface MedicationCardProps {
    medication: Medication;
    /** All schedules (the card links the active ones for this medication). */
    schedules: Schedule[];
    onEdit: (medication: Medication) => void;
    onDelete: (medication: Medication) => void;
    /** Adds/removes whole containers (FIFO removal, newest-lot top-up). */
    onAdjust: (medication: Medication, vialDelta: number) => void;
    /** Disables quick adjustments while a write is in flight for this row. */
    adjusting?: boolean;
}

const STATUS_BAR: Record<"out" | "low" | "ok", string> = {
    out: "[&_[data-slot=progress-indicator]]:bg-destructive",
    low: "[&_[data-slot=progress-indicator]]:bg-amber-500 dark:[&_[data-slot=progress-indicator]]:bg-amber-400",
    ok: "",
};

const LOW_STOCK_BADGE =
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";

const WARNING_TEXT = "text-amber-600 dark:text-amber-400";

/** Compact medication row: identity, lot-based inventory and schedule linkage. */
export function MedicationCard({
                                   medication,
                                   schedules,
                                   onEdit,
                                   onDelete,
                                   onAdjust,
                                   adjusting = false,
                               }: MedicationCardProps) {
    const meta = medicationTypeMeta(medication.type);
    const active = React.useMemo(
        () => activeSchedulesFor(schedules, medication.id),
        [schedules, medication.id]
    );
    const status = inventoryStatus(medication);
    const ratio = stockRatio(medication);
    const concentration = concentrationLabel(medication);
    const totals = inventoryTotals(medication);
    const priceTotals = inventoryPriceTotals(medication);
    const daysLeft = daysOfStockRemaining(medication, schedules);
    const duration = formatStockDuration(daysLeft);

    const containerPlural = `${meta.containerNoun}s`;
    const {lots, lowStockThreshold} = medication.inventory;
    const canAdd = !adjusting && lots.length > 0;
    const canRemove = !adjusting && totals.vialCount > 0;

    return (
        <Card className="gap-3 py-4">
            <CardContent className="flex flex-col gap-3 px-4">
                {/* Identity + actions */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <span
                            className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-md border",
                                meta.badgeClass
                            )}
                        >
                            <meta.icon className="size-4" aria-hidden/>
                        </span>
                        <div className="min-w-0">
                            <p className="truncate text-sm leading-tight font-semibold">
                                {medication.name}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <Badge
                                    variant="outline"
                                    className={cn("px-1.5 py-0 text-[11px]", meta.badgeClass)}
                                >
                                    {meta.label}
                                </Badge>
                                {status === "out" && (
                                    <Badge variant="destructive" className="px-1.5 py-0 text-[11px]">
                                        Out of stock
                                    </Badge>
                                )}
                                {status === "low" && (
                                    <Badge
                                        variant="outline"
                                        className={cn("px-1.5 py-0 text-[11px]", LOW_STOCK_BADGE)}
                                    >
                                        Low stock
                                    </Badge>
                                )}
                                {concentration && (
                                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                                        <FlaskConical className="size-3 shrink-0" aria-hidden/>
                                        {concentration.primary}
                                        {concentration.secondary &&
                                            ` (${concentration.secondary})`}
                                    </span>
                                )}
                                {medication.halfLifeHours !== undefined && (
                                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                                        <Timer className="size-3 shrink-0" aria-hidden/>
                                        t½ {formatNumber(medication.halfLifeHours)} h
                                    </span>
                                )}
                                {active.length > 0 && (
                                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                                        <CalendarClock className="size-3 shrink-0" aria-hidden/>
                                        {active.length} active
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Actions for ${medication.name}`}
                            >
                                <MoreHorizontal className="size-4" aria-hidden/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => onEdit(medication)}>
                                <Pencil className="size-4" aria-hidden/>
                                Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => onDelete(medication)}
                            >
                                <Trash2 className="size-4" aria-hidden/>
                                Delete…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                {/* Inventory tracker */}
                <div className="flex items-center gap-3">
                    <Progress
                        value={ratio * 100}
                        aria-label={`Stock level for ${medication.name}`}
                        className={cn("h-1.5 flex-1", STATUS_BAR[status])}
                    />
                    <span className="tabular-nums text-xs font-medium whitespace-nowrap">
                        {formatAmount(totals.quantity, medication.unit)}
                    </span>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={() => onAdjust(medication, -1)}
                            disabled={!canRemove}
                            aria-label={`Remove one ${meta.containerNoun}`}
                        >
                            <Minus className="size-3.5" aria-hidden/>
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={() => onAdjust(medication, 1)}
                            disabled={!canAdd}
                            aria-label={`Add one ${meta.containerNoun}`}
                        >
                            <Plus className="size-3.5" aria-hidden/>
                        </Button>
                    </div>
                </div>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="tabular-nums">
                        {formatNumber(totals.vialCount)}{" "}
                        {totals.vialCount === 1 ? meta.containerNoun : containerPlural}
                    </span>
                    <span className="tabular-nums">
                        · {totals.lotCount} {totals.lotCount === 1 ? "lot" : "lots"}
                    </span>
                    {lowStockThreshold !== undefined && (
                        <span className="tabular-nums">
                            · alert ≤ {formatAmount(lowStockThreshold, medication.unit)}
                        </span>
                    )}
                    {duration !== null && status !== "out" && (
                        <span
                            className={cn(
                                "tabular-nums",
                                status === "low" && WARNING_TEXT
                            )}
                        >
                            · ≈ {duration} of doses
                        </span>
                    )}
                    {duration === null && active.length > 0 && totals.quantity > 0 && (
                        <span className={cn("tabular-nums", WARNING_TEXT)}>
                            · duration unavailable
                        </span>
                    )}
                    {priceTotals.pricedLots > 0 && (
                        <span className="tabular-nums">
                            · stock value {formatPrice(priceTotals.totalPrice)}
                            {priceTotals.unpricedLots > 0 &&
                                ` (${priceTotals.unpricedLots} unpriced)`}
                        </span>
                    )}
                </div>

                {totals.unconvertibleLots > 0 && (
                    <p className={cn("inline-flex items-start gap-1.5 text-xs", WARNING_TEXT)}>
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden/>
                        {totals.unconvertibleLots}{" "}
                        {totals.unconvertibleLots === 1 ? "lot uses" : "lots use"} a content
                        unit that can’t be expressed in {medication.unit}. They are excluded
                        from stock and duration.
                    </p>
                )}

                {/* Lots */}
                {lots.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                            Inventory lots
                        </p>
                        <ul className="flex flex-col gap-1.5">
                            {lots.map((lot) => {
                                // Defensive: imported payloads bypass the form
                                // schema, so never turn a stored string into a
                                // non-http link target.
                                const coaUrls = (lot.coaUrls ?? []).filter((url) =>
                                    /^https?:\/\//i.test(url)
                                );
                                const lotPrice = lotTotalPrice(lot);
                                return (
                                    <li
                                        key={lot.id}
                                        className={cn(
                                            "border-border/60 flex flex-col gap-1 rounded-md border px-2.5 py-1.5 text-xs",
                                            lot.vialCount === 0 && "opacity-60"
                                        )}
                                    >
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="font-medium tabular-nums">
                                                {formatNumber(lot.vialCount)} ×{" "}
                                                {formatAmount(lot.contentAmount, lot.contentUnit)}
                                            </span>
                                            <span className="text-muted-foreground tabular-nums">
                                                = {formatAmount(lotTotalAmount(lot), lot.contentUnit)}
                                            </span>
                                            {lot.vendor && (
                                                <span className="text-muted-foreground truncate">
                                                    · {lot.vendor}
                                                </span>
                                            )}
                                            {lot.orderDate && (
                                                <span className="text-muted-foreground tabular-nums">
                                                    · ordered {lot.orderDate}
                                                </span>
                                            )}
                                            {lot.deliveryDate && (
                                                <span className="text-muted-foreground tabular-nums">
                                                    · delivered {lot.deliveryDate}
                                                </span>
                                            )}
                                            {lotPrice !== null && (
                                                <span className="text-muted-foreground tabular-nums">
                                                    · {formatPrice(lotPrice)}
                                                    {lot.vialCount > 0 &&
                                                        ` (${formatPrice(lotPrice / lot.vialCount)}/${meta.containerNoun})`}
                                                </span>
                                            )}
                                        </div>
                                        {(coaUrls.length > 0 || lot.notes) && (
                                            <div
                                                className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
                                                {coaUrls.map((url, index) => (
                                                    <a
                                                        key={`${lot.id}-coa-${index}`}
                                                        href={url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        title={url}
                                                        className="text-primary inline-flex items-center gap-1 hover:underline"
                                                    >
                                                        COA
                                                        {coaUrls.length > 1 ? ` ${index + 1}` : ""}
                                                        <ExternalLink className="size-3" aria-hidden/>
                                                    </a>
                                                ))}
                                                {lot.notes && (
                                                    <span className="line-clamp-1">{lot.notes}</span>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}

                {/* Schedule linkage with computed dose volumes */}
                <ScheduleSection medication={medication} schedules={active}/>

                {medication.notes && (
                    <p className="text-muted-foreground line-clamp-2 text-xs">
                        {medication.notes}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

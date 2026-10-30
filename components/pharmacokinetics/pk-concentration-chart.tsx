"use client";

import * as React from "react";
import {
    Area,
    CartesianGrid,
    ComposedChart,
    ReferenceArea,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import type {PkMedicationSeries} from "@/lib/pharmacokinetics/types";
import type {ChartRange} from "@/lib/pharmacokinetics/charting";
import {
    concentrationAxisLabel,
    type ConcentrationChartRow,
    type ConcentrationDisplayUnit,
    formatConcentration,
    formatConcentrationValue,
    seriesKey,
} from "@/lib/pharmacokinetics/charting";

// ---------------------------------------------------------------------------
// Local formatters (Intl uses the user's timezone, matching the rest of the app)
// ---------------------------------------------------------------------------

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
});

const tooltipDateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

function axisTick(value: number, days: number): string {
    if (days <= 1) return timeFormatter.format(value);
    if (days <= 14) return weekdayFormatter.format(value);
    if (days <= 60) return dateFormatter.format(value);
    return monthFormatter.format(value);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipEntry {
    dataKey?: string | number;
    name?: string | number;
    value?: number | string | ReadonlyArray<number | string>;
    color?: string;
    payload?: ConcentrationChartRow;
}

interface ConcentrationTooltipProps {
    active?: boolean;
    payload?: ReadonlyArray<TooltipEntry>;
    label?: string | number;
    unit: ConcentrationDisplayUnit;
}

function numericValue(value: TooltipEntry["value"]): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function ConcentrationTooltip({
                                  active,
                                  payload,
                                  label,
                                  unit,
                              }: ConcentrationTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;

    const entries = payload
        .map((entry) => ({entry, value: numericValue(entry.value)}))
        .filter(
            (item): item is { entry: TooltipEntry; value: number } =>
                item.value !== null
        )
        .sort((a, b) => b.value - a.value);

    if (entries.length === 0) return null;

    const timestamp =
        typeof label === "number"
            ? label
            : entries[0].entry.payload?.timestamp ?? Number(label);
    const total = entries.reduce((sum, item) => sum + item.value, 0);

    return (
        <div className="bg-popover text-popover-foreground min-w-48 rounded-lg border p-2.5 shadow-md">
            <p className="text-muted-foreground text-[11px] tabular-nums">
                {Number.isFinite(timestamp)
                    ? tooltipDateFormatter.format(timestamp)
                    : String(label ?? "")}
            </p>
            <div className="mt-1.5 flex flex-col gap-1">
                {entries.map(({entry, value}) => (
                    <div
                        key={String(entry.dataKey ?? entry.name)}
                        className="flex items-center justify-between gap-4 text-xs"
                    >
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{backgroundColor: entry.color ?? "var(--chart-1)"}}
                                aria-hidden
                            />
                            <span className="max-w-40 truncate">{entry.name}</span>
                        </span>
                        <span className="font-medium tabular-nums whitespace-nowrap">
                            {formatConcentration(value, unit)}
                        </span>
                    </div>
                ))}
            </div>
            {entries.length > 1 && (
                <div className="mt-1.5 flex items-center justify-between gap-4 border-t pt-1.5 text-xs">
                    <span className="text-muted-foreground">Combined</span>
                    <span className="font-semibold tabular-nums whitespace-nowrap">
                        {formatConcentration(total, unit)}
                    </span>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export interface PkConcentrationChartProps {
    rows: ConcentrationChartRow[];
    series: PkMedicationSeries[];
    colorById: ReadonlyMap<string, string>;
    unit: ConcentrationDisplayUnit;
    range: ChartRange;
    startMs: number;
    endMs: number;
    nowMs: number;
}

/**
 * Multi-medication overlay. The shaded right-hand region is the projection
 * tail (scheduled doses after "now"); the dashed line marks the present.
 */
export function PkConcentrationChart({
                                         rows,
                                         series,
                                         colorById,
                                         unit,
                                         range,
                                         startMs,
                                         endMs,
                                         nowMs,
                                     }: PkConcentrationChartProps) {
    return (
        <div
            className="h-[340px] w-full sm:h-[420px]"
            role="img"
            aria-label={`Estimated concentration curves for ${series
                .map((item) => item.medicationName)
                .join(", ")} over the selected ${range.label.toLowerCase()} window.`}
        >
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                    data={rows}
                    margin={{top: 18, right: 12, bottom: 0, left: 0}}
                    accessibilityLayer
                >
                    <CartesianGrid
                        vertical={false}
                        stroke="var(--border)"
                        strokeDasharray="3 3"
                    />
                    <ReferenceArea
                        x1={nowMs}
                        x2={endMs}
                        fill="var(--muted)"
                        fillOpacity={0.45}
                        stroke="none"
                    />
                    <XAxis
                        dataKey="timestamp"
                        type="number"
                        scale="time"
                        domain={[startMs, endMs]}
                        tickFormatter={(value) => axisTick(Number(value), range.days)}
                        tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
                        tickLine={false}
                        axisLine={{stroke: "var(--border)"}}
                        tickMargin={8}
                        minTickGap={32}
                        interval="preserveStartEnd"
                    />
                    <YAxis
                        width={64}
                        domain={[0, "auto"]}
                        tickFormatter={(value) => formatConcentrationValue(Number(value))}
                        tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={6}
                        label={{
                            value: concentrationAxisLabel(unit),
                            angle: -90,
                            position: "insideLeft",
                            offset: 4,
                            style: {
                                fontSize: 11,
                                fill: "var(--muted-foreground)",
                                textAnchor: "middle",
                            },
                        }}
                    />
                    <Tooltip
                        content={<ConcentrationTooltip unit={unit}/>}
                        cursor={{
                            stroke: "var(--muted-foreground)",
                            strokeWidth: 1,
                            strokeDasharray: "3 3",
                        }}
                        isAnimationActive={false}
                    />
                    <ReferenceLine
                        x={nowMs}
                        stroke="var(--muted-foreground)"
                        strokeDasharray="3 3"
                        strokeOpacity={0.7}
                        label={{
                            value: "Now",
                            position: "insideTopRight",
                            fill: "var(--muted-foreground)",
                            fontSize: 10,
                        }}
                    />
                    {series.map((item) => {
                        const color = colorById.get(item.medicationId) ?? "var(--chart-1)";
                        return (
                            <Area
                                key={item.medicationId}
                                type="monotone"
                                dataKey={seriesKey(item.medicationId)}
                                name={item.medicationName}
                                stroke={color}
                                strokeWidth={2}
                                fill={color}
                                fillOpacity={0.08}
                                dot={false}
                                activeDot={{r: 3, strokeWidth: 0}}
                                isAnimationActive={false}
                                connectNulls
                            />
                        );
                    })}
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}

"use client";

import * as React from "react";
import {CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,} from "recharts";

import type {MeasurementValueKind} from "@/lib/db/types";
import {formatNumber} from "@/lib/units";
import type {TrendChartRow} from "@/lib/measurements/derived";

// ---------------------------------------------------------------------------
// Local formatters (Intl uses the user's timezone, matching the app)
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
const tooltipFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

function axisTick(value: number, spanDays: number): string {
    if (spanDays <= 2) return timeFormatter.format(value);
    if (spanDays <= 60) return weekdayFormatter.format(value);
    return dateFormatter.format(value);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipEntry {
    dataKey?: string | number;
    name?: string | number;
    value?: number | string | ReadonlyArray<number | string>;
    color?: string;
}

interface TrendTooltipProps {
    active?: boolean;
    payload?: ReadonlyArray<TooltipEntry>;
    label?: string | number;
    unit: string;
}

function numericValue(value: TooltipEntry["value"]): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
}

function TrendTooltip({active, payload, label, unit}: TrendTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;

    const timestamp = typeof label === "number" ? label : Number(label);
    const entries = payload
        .map((entry) => ({entry, value: numericValue(entry.value)}))
        .filter(
            (item): item is { entry: TooltipEntry; value: number } => item.value !== null
        );
    if (entries.length === 0) return null;

    return (
        <div className="bg-popover text-popover-foreground rounded-lg border p-2.5 shadow-md">
            <p className="text-muted-foreground text-[11px] tabular-nums">
                {Number.isFinite(timestamp) ? tooltipFormatter.format(timestamp) : ""}
            </p>
            <div className="mt-1.5 flex flex-col gap-1">
                {entries.map(({entry, value}) => (
                    <div
                        key={String(entry.dataKey ?? entry.name)}
                        className="flex items-center justify-between gap-4 text-xs"
                    >
                        <span className="flex items-center gap-1.5">
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{backgroundColor: entry.color ?? "var(--chart-1)"}}
                                aria-hidden
                            />
                            <span>{entry.name}</span>
                        </span>
                        <span className="font-medium tabular-nums whitespace-nowrap">
                            {formatNumber(value)}
                            {unit ? ` ${unit}` : ""}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

const Y_AXIS_WIDTH = 52;

/** Series line colors — theme chart variables, matching the PK chart. */
const NUMERIC_COLOR = "var(--chart-1)";
const SYSTOLIC_COLOR = "var(--chart-1)";
const DIASTOLIC_COLOR = "var(--chart-2)";

export interface MeasurementTrendChartProps {
    rows: TrendChartRow[];
    kind: MeasurementValueKind;
    unit: string;
}

/**
 * Compact trend line for one tracker: a single series for numeric types, two
 * stacked lines (systolic over diastolic) for blood pressure, with a tiny
 * legend chip row when both series are shown.
 */
export function MeasurementTrendChart({rows, kind, unit}: MeasurementTrendChartProps) {
    const isBloodPressure = kind === "blood_pressure";
    const spanMs =
        rows.length > 1 ? rows[rows.length - 1].timestamp - rows[0].timestamp : 0;
    const spanDays = spanMs / (24 * 60 * 60 * 1000);
    // Sparse/single-point series: bracket the one reading by ±1 day so the
    // time axis stays sane (the manager only renders with ≥1 row).
    const domain: [number, number] =
        rows.length > 1
            ? [rows[0].timestamp, rows[rows.length - 1].timestamp]
            : [(rows[0]?.timestamp ?? 0) - 86_400_000, (rows[0]?.timestamp ?? 0) + 86_400_000];
    // Dots clutter dense series; show them only when the data is sparse.
    const showDots = rows.length <= 40;

    return (
        <div>
            {isBloodPressure && (
                <div className="mb-1 flex items-center justify-end gap-3 pr-2 text-[11px]">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                        <span
                            className="size-2 rounded-full"
                            style={{backgroundColor: SYSTOLIC_COLOR}}
                            aria-hidden
                        />
                        Systolic
                    </span>
                    <span className="text-muted-foreground flex items-center gap-1.5">
                        <span
                            className="size-2 rounded-full"
                            style={{backgroundColor: DIASTOLIC_COLOR}}
                            aria-hidden
                        />
                        Diastolic
                    </span>
                </div>
            )}
            <div className="h-[220px] w-full sm:h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                        data={rows}
                        margin={{top: 8, right: 12, bottom: 0, left: 0}}
                        accessibilityLayer
                    >
                        <CartesianGrid
                            vertical={false}
                            stroke="var(--border)"
                            strokeDasharray="3 3"
                        />
                        <XAxis
                            dataKey="timestamp"
                            type="number"
                            scale="time"
                            domain={domain}
                            tickFormatter={(value) => axisTick(Number(value), spanDays)}
                            tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
                            tickLine={false}
                            axisLine={{stroke: "var(--border)"}}
                            tickMargin={8}
                            minTickGap={32}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            width={Y_AXIS_WIDTH}
                            domain={["auto", "auto"]}
                            tickFormatter={(value) => formatNumber(Number(value))}
                            tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
                            tickLine={false}
                            axisLine={false}
                            tickMargin={6}
                        />
                        <Tooltip
                            content={<TrendTooltip unit={unit}/>}
                            cursor={{
                                stroke: "var(--muted-foreground)",
                                strokeWidth: 1,
                                strokeDasharray: "3 3",
                            }}
                            isAnimationActive={false}
                        />
                        {isBloodPressure ? (
                            <>
                                <Line
                                    type="monotone"
                                    dataKey="systolic"
                                    name="Systolic"
                                    stroke={SYSTOLIC_COLOR}
                                    strokeWidth={2}
                                    dot={showDots ? {r: 2.5, strokeWidth: 0} : false}
                                    activeDot={{r: 3.5, strokeWidth: 0}}
                                    isAnimationActive={false}
                                />
                                <Line
                                    type="monotone"
                                    dataKey="diastolic"
                                    name="Diastolic"
                                    stroke={DIASTOLIC_COLOR}
                                    strokeWidth={2}
                                    dot={showDots ? {r: 2.5, strokeWidth: 0} : false}
                                    activeDot={{r: 3.5, strokeWidth: 0}}
                                    isAnimationActive={false}
                                />
                            </>
                        ) : (
                            <Line
                                type="monotone"
                                dataKey="value"
                                name={unit || "Value"}
                                stroke={NUMERIC_COLOR}
                                strokeWidth={2}
                                dot={showDots ? {r: 2.5, strokeWidth: 0} : false}
                                activeDot={{r: 3.5, strokeWidth: 0}}
                                isAnimationActive={false}
                            />
                        )}
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

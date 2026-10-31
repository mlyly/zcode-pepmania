"use client";

import * as React from "react";
import Link from "next/link";
import {AlertCircle, ChartSpline, Clock3, Info, Pill, RefreshCw, Sparkles, TriangleAlert,} from "lucide-react";

import type {Medication} from "@/lib/db/types";
import {buildPkConcentrationSeries, type PkResult} from "@/lib/pharmacokinetics";
import {
    buildConcentrationChartRows,
    chartRangeById,
    type ChartRangeId,
    collectUpcomingDoses,
    concentrationAtInstant,
    type ConcentrationDisplayUnit,
    concentrationSuffix,
    convertConcentration,
    formatConcentration,
    resolveChartWindow,
} from "@/lib/pharmacokinetics/charting";
import {formatDay} from "@/lib/scheduling/dates";
import {formatNumber} from "@/lib/units";
import {cn} from "@/lib/utils";

import {DoseReadout} from "@/components/medications/dose-readout";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle,} from "@/components/ui/card";
import {Skeleton} from "@/components/ui/skeleton";

import {medicationIndex, useTrackerData} from "@/components/scheduling/use-tracker-data";
import {PkChartControls} from "./pk-chart-controls";
import {PkConcentrationChart} from "./pk-concentration-chart";

// Stable palette: CSS chart tokens first, then accessible fallbacks for
// dashboards with more than five medications.
const SERIES_COLORS = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "#8b5cf6",
    "#ec4899",
    "#0ea5e9",
    "#22c55e",
    "#f97316",
] as const;

type PkState =
    | { result: PkResult; error?: never }
    | { result?: never; error: string };

function hasHalfLife(medication: Medication): boolean {
    return (
        medication.halfLifeHours !== undefined &&
        Number.isFinite(medication.halfLifeHours) &&
        medication.halfLifeHours > 0
    );
}

function windowLabel(startMs: number, endMs: number): string {
    return `${formatDay(new Date(startMs))} – ${formatDay(new Date(endMs - 1))}`;
}

const instantLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Interactive concentration dashboard (AGENTS.md §4.2/§5): time-range presets,
 * per-medication multi-select and a display-unit toggle over the local PK
 * engine. Everything is computed in memory from the local database.
 */
export function PkChartDashboard() {
    const {phase, data, reload} = useTrackerData();

    const [rangeId, setRangeId] = React.useState<ChartRangeId>("week");
    const [unit, setUnit] = React.useState<ConcentrationDisplayUnit>("mcg");
    const [deselectedIds, setDeselectedIds] = React.useState<Set<string>>(
        () => new Set()
    );
    const [now, setNow] = React.useState<Date>(() => new Date());
    const [refreshing, setRefreshing] = React.useState(false);

    // Keep the Now line and the three-slot window fresh without making the
    // page depend on a full reload. Only the chart consumes `now`, and it
    // renders after the data loads, so the initial value can't skew hydration.
    React.useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    const range = chartRangeById(rangeId);

    const availableMedications = React.useMemo(
        () => data.medications.filter(hasHalfLife),
        [data.medications]
    );
    const availableIds = React.useMemo(
        () => new Set(availableMedications.map((medication) => medication.id)),
        [availableMedications]
    );
    const selectedIds = React.useMemo(
        () =>
            new Set(
                availableMedications
                    .filter((medication) => !deselectedIds.has(medication.id))
                    .map((medication) => medication.id)
            ),
        [availableMedications, deselectedIds]
    );
    const selectedMedications = React.useMemo(
        () =>
            availableMedications.filter((medication) =>
                selectedIds.has(medication.id)
            ),
        [availableMedications, selectedIds]
    );

    const colorById = React.useMemo(() => {
        const map = new Map<string, string>();
        data.medications.forEach((medication, index) => {
            map.set(
                medication.id,
                SERIES_COLORS[index % SERIES_COLORS.length]
            );
        });
        return map;
    }, [data.medications]);

    const medicationsById = React.useMemo(
        () => medicationIndex(data.medications),
        [data.medications]
    );

    // Real clock, refreshed each minute; pins the Now line to the start of
    // the third slot via resolveChartWindow's fixed 2/3–1/3 split.
    const nowMs = now.getTime();
    const timeWindow = React.useMemo(() => {
        const resolved = resolveChartWindow(range, now);
        return {
            startMs: resolved.start.getTime(),
            endMs: resolved.end.getTime(),
        };
    }, [range, now]);

    const pkState = React.useMemo<PkState | null>(() => {
        if (selectedMedications.length === 0) return null;
        try {
            return {
                result: buildPkConcentrationSeries(
                    {
                        medications: selectedMedications,
                        schedules: data.schedules,
                        doseLogs: data.doseLogs,
                    },
                    {
                        start: timeWindow.startMs,
                        end: timeWindow.endMs,
                        now: nowMs,
                        stepMinutes: range.stepMinutes,
                        maxPoints: 2000,
                    }
                ),
            };
        } catch (error: unknown) {
            return {
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [
        data.doseLogs,
        data.schedules,
        nowMs,
        range,
        selectedMedications,
        timeWindow,
    ]);

    const result = pkState?.result ?? null;

    const rows = React.useMemo(
        () =>
            result ? buildConcentrationChartRows(result.series, unit) : [],
        [result, unit]
    );

    // Scheduled doses after now, inside the projection slot. The engine
    // flags occurrences past its `now` option as projected.
    const upcoming = React.useMemo(
        () =>
            result
                ? collectUpcomingDoses(result, {
                    fromMs: nowMs,
                    toMs: timeWindow.endMs,
                    unit,
                })
                : [],
        [result, nowMs, timeWindow.endMs, unit]
    );

    const stats = React.useMemo(() => {
        if (!result || result.series.length === 0) return null;

        const peaks = result.series.map((item) => ({
            name: item.medicationName,
            value: convertConcentration(item.peak.concentration, unit),
            timestamp: item.peak.timestamp,
        }));
        const topPeak = peaks.reduce((best, current) =>
            current.value > best.value ? current : best
        );
        const combinedNow = result.series.reduce(
            (sum, item) =>
                sum +
                convertConcentration(
                    concentrationAtInstant(item.points, nowMs),
                    unit
                ),
            0
        );
        const logged = result.series.reduce(
            (sum, item) => sum + item.doseCounts.logged,
            0
        );
        const scheduled = result.series.reduce(
            (sum, item) => sum + item.doseCounts.scheduled,
            0
        );

        return {topPeak, combinedNow, logged, scheduled};
    }, [result, nowMs, unit]);

    const toggleMedication = React.useCallback(
        (medicationId: string) => {
            if (!availableIds.has(medicationId)) return;
            setDeselectedIds((current) => {
                const next = new Set(current);
                if (next.has(medicationId)) next.delete(medicationId);
                else next.add(medicationId);
                return next;
            });
        },
        [availableIds]
    );

    const selectAll = React.useCallback(() => {
        setDeselectedIds(new Set());
    }, []);

    const clearSelection = React.useCallback(() => {
        setDeselectedIds(new Set(availableMedications.map((m) => m.id)));
    }, [availableMedications]);

    const refresh = React.useCallback(async () => {
        setRefreshing(true);
        try {
            await reload();
            setNow(new Date());
        } finally {
            setRefreshing(false);
        }
    }, [reload]);

    if (phase.phase === "loading") {
        return <DashboardSkeleton/>;
    }

    if (phase.phase === "error") {
        return (
            <Card className="border-destructive/40">
                <CardContent className="flex items-start gap-2 px-4 py-4 text-sm">
                    <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden/>
                    <div>
                        <p className="font-medium">Could not load local data</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                            {phase.message}
                        </p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    const uniqueWarnings = result
        ? [...new Map(result.warnings.map((warning) => [warning.message, warning])).values()]
        : [];

    return (
        <div className="flex flex-col gap-4">
            <Card className="gap-0 py-0">
                <CardHeader className="border-b py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Sparkles className="size-4" aria-hidden/>
                                Chart controls
                            </CardTitle>
                            <CardDescription>
                                Pick a window, choose the medications to overlay and switch
                                the concentration unit.
                            </CardDescription>
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2"
                            onClick={() => void refresh()}
                            disabled={refreshing}
                        >
                            <RefreshCw
                                className={cn("size-4", refreshing && "animate-spin")}
                                aria-hidden
                            />
                            Refresh
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="py-4">
                    <PkChartControls
                        rangeId={rangeId}
                        onRangeChange={setRangeId}
                        unit={unit}
                        onUnitChange={setUnit}
                        medications={data.medications}
                        availableIds={availableIds}
                        selectedIds={selectedIds}
                        colorById={colorById}
                        onToggleMedication={toggleMedication}
                        onSelectAll={selectAll}
                        onClearSelection={clearSelection}
                    />
                </CardContent>
            </Card>

            {data.medications.length === 0 ? (
                <EmptyState
                    icon={<Pill className="size-5" aria-hidden/>}
                    title="No medications to chart yet"
                    description="Add a medication and its half-life to see an estimated concentration curve."
                    action={
                        <Button asChild size="sm">
                            <Link href="/medications">Add a medication</Link>
                        </Button>
                    }
                />
            ) : availableMedications.length === 0 ? (
                <EmptyState
                    icon={<ChartSpline className="size-5" aria-hidden/>}
                    title="No half-life configured"
                    description="The concentration model needs an elimination half-life. Edit a medication to add one, then come back."
                    action={
                        <Button asChild size="sm">
                            <Link href="/medications">Edit medications</Link>
                        </Button>
                    }
                />
            ) : selectedMedications.length === 0 ? (
                <EmptyState
                    icon={<ChartSpline className="size-5" aria-hidden/>}
                    title="No curves selected"
                    description="Every medication is toggled off. Show all of them or pick one from the filter above."
                    action={
                        <Button size="sm" onClick={selectAll}>
                            Show all medications
                        </Button>
                    }
                />
            ) : pkState?.error ? (
                <EmptyState
                    icon={<AlertCircle className="text-destructive size-5" aria-hidden/>}
                    title="Could not build the concentration model"
                    description={pkState.error}
                />
            ) : result && result.series.length > 0 ? (
                <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatCard
                            label="Combined now"
                            value={formatConcentration(
                                stats?.combinedNow ?? 0,
                                unit
                            )}
                            hint={instantLabel.format(nowMs)}
                        />
                        <StatCard
                            label="Window peak"
                            value={formatConcentration(stats?.topPeak.value ?? 0, unit)}
                            hint={
                                stats
                                    ? `${stats.topPeak.name} · ${formatDay(
                                        new Date(stats.topPeak.timestamp)
                                    )}`
                                    : undefined
                            }
                        />
                        <StatCard
                            label="Doses in window"
                            value={formatNumber(
                                (stats?.logged ?? 0) + (stats?.scheduled ?? 0)
                            )}
                            hint={`${stats?.logged ?? 0} logged · ${upcoming.length} upcoming`}
                        />
                        <StatCard
                            label="Active curves"
                            value={`${result.series.length}`}
                            hint={`of ${availableMedications.length} plottable medication${
                                availableMedications.length === 1 ? "" : "s"
                            }`}
                        />
                    </div>

                    <Card>
                        <CardHeader className="border-b pb-4">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        <ChartSpline className="size-4" aria-hidden/>
                                        Estimated concentration
                                    </CardTitle>
                                    <CardDescription>
                                        First-order elimination overlay.{" "}
                                        <span className="text-foreground font-medium">
                                            {windowLabel(timeWindow.startMs, timeWindow.endMs)}
                                        </span>
                                    </CardDescription>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge variant="outline" className="tabular-nums">
                                        <Clock3 className="size-3" aria-hidden/>
                                        {range.label}
                                    </Badge>
                                    <Badge variant="secondary" className="tabular-nums">
                                        {concentrationSuffix(unit)}
                                    </Badge>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="pt-4">
                            <PkConcentrationChart
                                rows={rows}
                                series={result.series}
                                colorById={colorById}
                                unit={unit}
                                range={range}
                                startMs={timeWindow.startMs}
                                endMs={timeWindow.endMs}
                                nowMs={nowMs}
                                upcoming={upcoming}
                            />

                            {/* Next scheduled doses after the simulated now. */}
                            <div className="mt-3 flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-3 py-2.5">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-medium">
                                        Upcoming doses (after now)
                                    </p>
                                    <Badge variant="secondary" className="px-1.5 py-0 text-[11px] tabular-nums">
                                        {upcoming.length}
                                    </Badge>
                                </div>
                                {upcoming.length === 0 ? (
                                    <p className="text-muted-foreground text-xs">
                                        No scheduled doses after the current now-moment in
                                        this window.
                                    </p>
                                ) : (
                                    <ul className="flex flex-col gap-1">
                                        {upcoming.slice(0, 5).map((dose) => {
                                            const color =
                                                colorById.get(dose.medicationId) ??
                                                "var(--chart-1)";
                                            return (
                                                <li
                                                    key={dose.id}
                                                    className="flex items-center justify-between gap-3 text-xs"
                                                >
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        <span
                                                            className="size-2 shrink-0 rounded-full border-2 bg-transparent"
                                                            style={{borderColor: color}}
                                                            aria-hidden
                                                        />
                                                        <span className="max-w-36 truncate font-medium">
                                                            {dose.medicationName}
                                                        </span>
                                                    </span>
                                                    <span
                                                        className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums">
                                                        <span className="whitespace-nowrap">
                                                            {instantLabel.format(dose.timestamp)}
                                                        </span>
                                                        <span aria-hidden>·</span>
                                                        <DoseReadout
                                                            amount={convertConcentration(
                                                                dose.amountMg,
                                                                unit
                                                            )}
                                                            unit={unit}
                                                            medication={
                                                                medicationsById.get(
                                                                    dose.medicationId
                                                                ) ?? null
                                                            }
                                                        />
                                                    </span>
                                                </li>
                                            );
                                        })}
                                        {upcoming.length > 5 && (
                                            <li className="text-muted-foreground text-[11px]">
                                                +{upcoming.length - 5} more shown as markers
                                                on the curve
                                            </li>
                                        )}
                                    </ul>
                                )}
                            </div>

                            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t pt-3">
                                {result.series.map((item) => {
                                    const color =
                                        colorById.get(item.medicationId) ??
                                        "var(--chart-1)";
                                    return (
                                        <div
                                            key={item.medicationId}
                                            className="flex min-w-0 items-center gap-1.5 text-xs"
                                        >
                                            <span
                                                className="size-2 shrink-0 rounded-full"
                                                style={{backgroundColor: color}}
                                                aria-hidden
                                            />
                                            <span className="max-w-40 truncate font-medium">
                                                {item.medicationName}
                                            </span>
                                            <span className="text-muted-foreground tabular-nums">
                                                peak{" "}
                                                {formatConcentration(
                                                    convertConcentration(
                                                        item.peak.concentration,
                                                        unit
                                                    ),
                                                    unit
                                                )}
                                            </span>
                                            <span className="text-muted-foreground/70 tabular-nums">
                                                t½ {formatNumber(item.profile.halfLifeHours)}h
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>

                            <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-[11px]">
                                <Info className="mt-0.5 size-3 shrink-0" aria-hidden/>
                                The chart is split into three equal time slots: two of
                                history, then the Now line at the start of the third slot —
                                a fixed projection window where upcoming scheduled doses
                                (open rings) are modeled ahead of you. Curves are model
                                estimates in dose-equivalent units, not clinical
                                measurements.
                                {unit === "IU" &&
                                    " IU follows the app's 1:1 mg fallback."}
                            </p>
                        </CardContent>
                    </Card>

                    {uniqueWarnings.length > 0 && (
                        <Card className="border-amber-500/40 bg-amber-500/5">
                            <CardContent className="flex items-start gap-2 px-4 py-3 text-xs">
                                <TriangleAlert
                                    className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                                    aria-hidden
                                />
                                <div className="flex flex-col gap-1">
                                    <p className="font-medium">Model notes</p>
                                    {uniqueWarnings.slice(0, 4).map((warning) => (
                                        <p
                                            key={warning.message}
                                            className="text-muted-foreground"
                                        >
                                            {warning.message}
                                        </p>
                                    ))}
                                    {uniqueWarnings.length > 4 && (
                                        <p className="text-muted-foreground">
                                            +{uniqueWarnings.length - 4} more note
                                            {uniqueWarnings.length - 4 === 1 ? "" : "s"}
                                        </p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </>
            ) : (
                <EmptyState
                    icon={<ChartSpline className="size-5" aria-hidden/>}
                    title="No curve could be plotted"
                    description="The selected medications have no usable doses in this window. Log a dose or add an active schedule."
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatCard({
                      label,
                      value,
                      hint,
                  }: {
    label: string;
    value: string;
    hint?: string;
}) {
    return (
        <Card className="gap-1 py-3">
            <CardContent className="px-3">
                <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                    {label}
                </p>
                <p className="mt-1 truncate text-lg font-semibold tabular-nums">
                    {value}
                </p>
                {hint && (
                    <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
                        {hint}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

function EmptyState({
                        icon,
                        title,
                        description,
                        action,
                    }: {
    icon: React.ReactNode;
    title: string;
    description: string;
    action?: React.ReactNode;
}) {
    return (
        <Card>
            <CardContent className="flex flex-col items-start gap-3 px-4 py-6">
                <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
                    {icon}
                </span>
                <div>
                    <p className="font-medium">{title}</p>
                    <p className="text-muted-foreground mt-1 max-w-xl text-sm">
                        {description}
                    </p>
                </div>
                {action}
            </CardContent>
        </Card>
    );
}

function DashboardSkeleton() {
    return (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading chart">
            <Card className="gap-0 py-0">
                <CardContent className="flex flex-col gap-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Skeleton className="h-8 w-72"/>
                        <Skeleton className="h-8 w-40"/>
                    </div>
                    <Skeleton className="h-8 w-full"/>
                </CardContent>
            </Card>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({length: 4}).map((_, index) => (
                    <Skeleton key={index} className="h-20 w-full"/>
                ))}
            </div>
            <Skeleton className="h-[420px] w-full"/>
        </div>
    );
}

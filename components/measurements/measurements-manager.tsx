"use client";

import * as React from "react";
import {AlertCircle, MoreHorizontal, Pencil, Plus, Settings2, Trash2, TrendingDown, TrendingUp,} from "lucide-react";

import type {MeasurementLog, MeasurementType} from "@/lib/db/types";
import {storageAwareMessage} from "@/lib/db/quota";
import {
    buildTrendRows,
    effectiveKind,
    filterLogsForRange,
    formatDelta,
    formatMeasurementValue,
    parseMeasurementValue,
    summarizeLogs,
    TREND_RANGES,
    type TrendRange,
} from "@/lib/measurements/derived";
import {deleteMeasurementLog, deleteMeasurementType} from "@/lib/measurements/service";
import {BUILTIN_MEASUREMENT_TYPES, isBuiltinMeasurementType, measurementTypeIcon,} from "@/lib/measurements/constants";
import {dateOnlyIso, formatRelativeDay, isSameLocalDay} from "@/lib/scheduling/dates";
import {formatNumber} from "@/lib/units";
import {cn} from "@/lib/utils";

import {ConfirmDialog} from "@/components/app/confirm-dialog";
import {type Feedback, FeedbackLine} from "@/components/ui/feedback-line";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {Skeleton} from "@/components/ui/skeleton";

import {MeasurementLogDialog} from "./measurement-log-dialog";
import {MeasurementLogRow} from "./measurement-log-row";
import {MeasurementTrendChart} from "./measurement-trend-chart";
import {MeasurementTypeDialog} from "./measurement-type-dialog";
import {measurementTypeIndex, useMeasurementsData} from "./use-measurements-data";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

interface DeleteLogTarget {
    log: MeasurementLog;
    typeName: string;
}

interface DeleteTypeTarget {
    type: MeasurementType;
    logCount: number;
}

/** One local-day group in the history list (newest day first). */
interface DayGroup {
    day: Date;
    logs: MeasurementLog[];
}

// ---------------------------------------------------------------------------
// Tracker card
// ---------------------------------------------------------------------------

function TrackerCard({
                         type,
                         selected,
                         logCount,
                         latest,
                         delta,
                         onSelect,
                     }: {
    type: MeasurementType;
    selected: boolean;
    logCount: number;
    latest: MeasurementLog | null;
    delta: number | null;
    onSelect: () => void;
}) {
    const kind = effectiveKind(type);
    const parsed = latest ? parseMeasurementValue(latest.value, kind) : null;
    // Object-wrapped icon so JSX uses property access (`<typeMeta.icon/>`),
    // matching the `<meta.icon/>` pattern of `DoseLogRow`.
    const typeMeta = {icon: measurementTypeIcon(type)};

    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className={cn(
                "flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                selected
                    ? "border-primary/60 bg-accent"
                    : "hover:bg-accent/50 bg-card"
            )}
        >
            <span
                className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg border",
                    selected
                        ? "border-primary/30 text-primary bg-primary/10"
                        : "bg-muted text-muted-foreground"
                )}
            >
                <typeMeta.icon className="size-4" aria-hidden/>
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm leading-tight font-semibold">
                    {type.name}
                </span>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs tabular-nums">
                    {parsed ? formatMeasurementValue(parsed, type.unit) : "No readings yet"}
                    {logCount > 0 && ` · ${logCount} ${logCount === 1 ? "entry" : "entries"}`}
                </span>
            </span>
            {delta !== null && delta !== 0 && (
                <span
                    className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
                    title="vs previous reading"
                >
                    {delta > 0 ? (
                        <TrendingUp className="size-3" aria-hidden/>
                    ) : (
                        <TrendingDown className="size-3" aria-hidden/>
                    )}
                    {formatDelta(delta)}
                </span>
            )}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Body-metrics surface: tracker cards (Weight & Blood Pressure built in, any
 * custom unit you add), a trend chart with range toggle, summary stats and a
 * day-grouped history with inline add / edit / delete. Boots the local
 * database via `useMeasurementsData` and reloads after each write.
 */
export function MeasurementsManager() {
    const {
        phase,
        data,
        reload,
        selectedType,
        selectType,
        range,
        setRange,
        selectedLogs,
        logCountByType,
    } = useMeasurementsData();

    const [feedback, setFeedback] = React.useState<Feedback>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const [logFormOpen, setLogFormOpen] = React.useState(false);
    const [editingLog, setEditingLog] = React.useState<MeasurementLog | null>(null);
    const [deleteLogTarget, setDeleteLogTarget] = React.useState<DeleteLogTarget | null>(null);

    const [typeFormOpen, setTypeFormOpen] = React.useState(false);
    const [editingType, setEditingType] = React.useState<MeasurementType | null>(null);
    const [deleteTypeTarget, setDeleteTypeTarget] = React.useState<DeleteTypeTarget | null>(null);

    const typeIndex = React.useMemo(
        () => measurementTypeIndex(data.types),
        [data.types]
    );

    const reportError = React.useCallback((error: unknown, prefix: string) => {
        setFeedback({kind: "error", message: storageAwareMessage(error, prefix)});
    }, []);

    // Auto-dismiss success feedback.
    React.useEffect(() => {
        if (feedback?.kind !== "success") return;
        const timer = window.setTimeout(() => setFeedback(null), 4000);
        return () => window.clearTimeout(timer);
    }, [feedback]);

    // -- Handlers ----------------------------------------------------------

    const onChanged = React.useCallback(() => {
        void reload();
    }, [reload]);

    const openCreateLog = React.useCallback(() => {
        setEditingLog(null);
        setLogFormOpen(true);
    }, []);

    const openEditLog = React.useCallback((log: MeasurementLog) => {
        setEditingLog(log);
        setLogFormOpen(true);
    }, []);

    const openCreateType = React.useCallback(() => {
        setEditingType(null);
        setTypeFormOpen(true);
    }, []);

    const openEditType = React.useCallback((type: MeasurementType) => {
        setEditingType(type);
        setTypeFormOpen(true);
    }, []);

    const handleLogSaved = React.useCallback(
        (saved: MeasurementLog, mode: "created" | "updated") => {
            const name = typeIndex.get(saved.measurementTypeId)?.name;
            setFeedback({
                kind: "success",
                message:
                    mode === "created"
                        ? `${name ? `${name} ` : ""}reading logged.`
                        : "Reading updated.",
            });
            onChanged();
        },
        [typeIndex, onChanged]
    );

    const handleTypeSaved = React.useCallback(
        (saved: MeasurementType, mode: "created" | "updated") => {
            setFeedback({
                kind: "success",
                message:
                    mode === "created"
                        ? `Tracker “${saved.name}” created.`
                        : `Tracker “${saved.name}” updated.`,
            });
            if (mode === "created") selectType(saved.id);
            onChanged();
        },
        [onChanged, selectType]
    );

    const requestDeleteLog = React.useCallback(
        (log: MeasurementLog) => {
            setDeleteLogTarget({
                log,
                typeName: typeIndex.get(log.measurementTypeId)?.name ?? "reading",
            });
        },
        [typeIndex]
    );

    const confirmDeleteLog = React.useCallback(async () => {
        if (!deleteLogTarget) return;
        setBusyId(deleteLogTarget.log.id);
        try {
            await deleteMeasurementLog(deleteLogTarget.log.id);
            setFeedback({kind: "success", message: "Reading deleted."});
            setDeleteLogTarget(null);
            onChanged();
        } catch (error: unknown) {
            reportError(error, "Delete failed");
            setDeleteLogTarget(null);
        } finally {
            setBusyId(null);
        }
    }, [deleteLogTarget, onChanged, reportError]);

    const requestDeleteType = React.useCallback(
        (type: MeasurementType) => {
            setDeleteTypeTarget({
                type,
                logCount: logCountByType.get(type.id) ?? 0,
            });
        },
        [logCountByType]
    );

    const confirmDeleteType = React.useCallback(async () => {
        if (!deleteTypeTarget) return;
        setBusyId(deleteTypeTarget.type.id);
        try {
            await deleteMeasurementType(deleteTypeTarget.type.id);
            setFeedback({
                kind: "success",
                message: `Tracker “${deleteTypeTarget.type.name}” deleted.`,
            });
            setDeleteTypeTarget(null);
            onChanged();
        } catch (error: unknown) {
            reportError(error, "Delete failed");
            setDeleteTypeTarget(null);
        } finally {
            setBusyId(null);
        }
    }, [deleteTypeTarget, onChanged, reportError]);

    // -- Derived view state ------------------------------------------------

    const rangeLogs = React.useMemo(() => {
        if (!selectedType) return [];
        return filterLogsForRange(selectedLogs, selectedType.id, range);
    }, [selectedLogs, selectedType, range]);

    const trendRows = React.useMemo(
        () => buildTrendRows(rangeLogs, effectiveKind(selectedType)),
        [rangeLogs, selectedType]
    );

    const summary = React.useMemo(
        () => summarizeLogs(rangeLogs, effectiveKind(selectedType)),
        [rangeLogs, selectedType]
    );

    // Latest overall reading (regardless of chart range) for card chips.
    const cardMeta = React.useMemo(() => {
        const meta = new Map<
            string,
            { latest: MeasurementLog | null; delta: number | null }
        >();
        for (const type of data.types) {
            const logs = data.logs.filter(
                (log) => log.measurementTypeId === type.id
            );
            if (logs.length === 0) {
                meta.set(type.id, {latest: null, delta: null});
                continue;
            }
            const kind = effectiveKind(type);
            const values: number[] = [];
            let systolicDelta: number | null = null;
            let latest: MeasurementLog | null = null;
            for (const log of logs) {
                const parsed = parseMeasurementValue(log.value, kind);
                if (!parsed) continue;
                if (!latest) latest = log;
                if (parsed.kind === "blood_pressure") {
                    values.push(parsed.value.systolic);
                } else {
                    values.push(parsed.value);
                }
            }
            if (kind === "blood_pressure" && values.length >= 2) {
                systolicDelta = values[0] - values[1];
            }
            meta.set(type.id, {
                latest,
                delta: kind === "blood_pressure" ? systolicDelta : values.length >= 2 ? values[0] - values[1] : null,
            });
        }
        return meta;
    }, [data.types, data.logs]);

    const groups = React.useMemo<DayGroup[]>(() => {
        // `listMeasurementLogs` returns newest first, so grouping in order
        // yields newest day first; within a day entries stay in log order.
        const result: DayGroup[] = [];
        for (const log of rangeLogs) {
            const instant = new Date(log.timestamp);
            const last = result[result.length - 1];
            if (!last || !isSameLocalDay(instant, last.day)) {
                result.push({day: instant, logs: [log]});
            } else {
                last.logs.push(log);
            }
        }
        return result;
    }, [rangeLogs]);

    const emptyHint = React.useMemo(() => {
        if (!selectedType) return "";
        const builtin = BUILTIN_MEASUREMENT_TYPES.find((s) => s.id === selectedType.id);
        return builtin?.emptyHint ?? "Log your first reading to start the trend.";
    }, [selectedType]);

    // -- Render ------------------------------------------------------------

    if (phase.phase === "error") {
        return (
            <Card className="border-destructive/50">
                <CardContent className="text-destructive flex items-start gap-2 px-4 text-sm">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden/>
                    <span>Database error: {phase.message}</span>
                </CardContent>
            </Card>
        );
    }

    if (phase.phase === "loading") {
        return (
            <div className="flex flex-col gap-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <Skeleton className="h-16 rounded-xl"/>
                    <Skeleton className="h-16 rounded-xl"/>
                    <Skeleton className="h-16 rounded-xl"/>
                </div>
                <Skeleton className="h-72 w-full rounded-xl"/>
            </div>
        );
    }

    const selectedIsBuiltin = selectedType
        ? isBuiltinMeasurementType(selectedType.id) || !selectedType.isCustom
        : false;

    return (
        <div className="flex flex-col gap-3">
            {/* Feedback line */}
            <FeedbackLine feedback={feedback} onDismiss={() => setFeedback(null)}/>

            {/* Tracker selector */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.types.map((type) => (
                    <TrackerCard
                        key={type.id}
                        type={type}
                        selected={selectedType?.id === type.id}
                        logCount={logCountByType.get(type.id) ?? 0}
                        latest={cardMeta.get(type.id)?.latest ?? null}
                        delta={cardMeta.get(type.id)?.delta ?? null}
                        onSelect={() => selectType(type.id)}
                    />
                ))}
                <button
                    type="button"
                    onClick={openCreateType}
                    className={cn(
                        "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                        "flex items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-sm transition-colors"
                    )}
                >
                    <Plus className="size-4" aria-hidden/>
                    New tracker
                </button>
            </div>

            {/* Selected tracker panel */}
            {selectedType && (
                <Card className="gap-0 py-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <h2 className="truncate text-sm font-semibold">
                                {selectedType.name}
                            </h2>
                            <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                                {selectedType.unit}
                            </Badge>
                            {effectiveKind(selectedType) === "blood_pressure" && (
                                <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                                    sys/dia
                                </Badge>
                            )}
                            {!selectedIsBuiltin && (
                                <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                                    custom
                                </Badge>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Button size="sm" onClick={openCreateLog}>
                                <Plus className="size-4" aria-hidden/>
                                Log reading
                            </Button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8"
                                        aria-label={`Manage ${selectedType.name}`}
                                    >
                                        <MoreHorizontal className="size-4" aria-hidden/>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => openEditType(selectedType)}>
                                        <Pencil className="size-4" aria-hidden/>
                                        Edit tracker
                                    </DropdownMenuItem>
                                    {!selectedIsBuiltin && (
                                        <>
                                            <DropdownMenuSeparator/>
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => requestDeleteType(selectedType)}
                                            >
                                                <Trash2 className="size-4" aria-hidden/>
                                                Delete tracker…
                                            </DropdownMenuItem>
                                        </>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>

                    {/* Summary chips */}
                    <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
                        {summary.kind === "numeric" ? (
                            summary.stats ? (
                                <>
                                    <Badge variant="outline" className="tabular-nums">
                                        Latest {formatNumber(summary.stats.latest)}{" "}
                                        {selectedType.unit}
                                    </Badge>
                                    {summary.stats.delta !== null && (
                                        <Badge
                                            variant="outline"
                                            className="flex items-center gap-1 tabular-nums"
                                        >
                                            {summary.stats.delta > 0 ? (
                                                <TrendingUp className="size-3" aria-hidden/>
                                            ) : summary.stats.delta < 0 ? (
                                                <TrendingDown className="size-3" aria-hidden/>
                                            ) : null}
                                            {formatDelta(summary.stats.delta)}
                                        </Badge>
                                    )}
                                    <Badge variant="outline" className="tabular-nums">
                                        Min {formatNumber(summary.stats.min)} · Avg{" "}
                                        {formatNumber(Math.round(summary.stats.avg * 100) / 100)} · Max{" "}
                                        {formatNumber(summary.stats.max)}
                                    </Badge>
                                </>
                            ) : (
                                <Badge variant="outline">No readings in range</Badge>
                            )
                        ) : summary.systolic && summary.diastolic ? (
                            <>
                                <Badge variant="outline" className="tabular-nums">
                                    Latest {formatNumber(summary.systolic.latest)}/
                                    {formatNumber(summary.diastolic.latest)} {selectedType.unit}
                                </Badge>
                                {summary.systolic.delta !== null && (
                                    <Badge variant="outline" className="tabular-nums">
                                        Sys {formatDelta(summary.systolic.delta)} · Dia{" "}
                                        {summary.diastolic.delta !== null
                                            ? formatDelta(summary.diastolic.delta)
                                            : "—"}
                                    </Badge>
                                )}
                                <Badge variant="outline" className="tabular-nums">
                                    Avg {formatNumber(Math.round(summary.systolic.avg))}/
                                    {formatNumber(Math.round(summary.diastolic.avg))}
                                </Badge>
                            </>
                        ) : (
                            <Badge variant="outline">No readings in range</Badge>
                        )}
                        <Badge variant="secondary" className="tabular-nums">
                            {rangeLogs.length} in range · {selectedLogs.length} total
                        </Badge>
                    </div>

                    {/* Range toggle + chart */}
                    <CardContent className="px-2 pb-2 pt-2">
                        <div className="flex flex-wrap items-center gap-2 px-2">
                            <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
                                {TREND_RANGES.map((option: TrendRange) => (
                                    <button
                                        key={option}
                                        type="button"
                                        onClick={() => setRange(option)}
                                        aria-pressed={range === option}
                                        className={cn(
                                            "tap rounded-md px-2 py-1 text-xs font-medium transition-colors",
                                            range === option
                                                ? "bg-primary text-primary-foreground"
                                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                                        )}
                                    >
                                        {option === "all" ? "All" : option}
                                    </button>
                                ))}
                            </div>
                            <span
                                className="text-muted-foreground ml-auto hidden items-center gap-1 pr-1 text-xs sm:flex">
                                <Settings2 className="size-3" aria-hidden/>
                                {trendRows.length} plotted
                            </span>
                        </div>

                        <div className="mt-2 px-2">
                            {trendRows.length === 0 ? (
                                <div
                                    className="text-muted-foreground flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed py-10 text-center text-sm">
                                    <p>No readings yet</p>
                                    <p className="max-w-sm text-xs">{emptyHint}</p>
                                </div>
                            ) : (
                                <MeasurementTrendChart
                                    rows={trendRows}
                                    kind={effectiveKind(selectedType)}
                                    unit={selectedType.unit}
                                />
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Day-grouped history */}
            {groups.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h3 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                        History
                    </h3>
                    {groups.map((group) => (
                        <div key={dateOnlyIso(group.day)} className="flex flex-col gap-2">
                            <p className="text-muted-foreground px-1 text-xs font-medium">
                                {formatRelativeDay(group.day)}
                            </p>
                            {group.logs.map((log) => (
                                <MeasurementLogRow
                                    key={log.id}
                                    log={log}
                                    type={typeIndex.get(log.measurementTypeId) ?? null}
                                    onEdit={openEditLog}
                                    onDelete={requestDeleteLog}
                                    busy={busyId === log.id}
                                />
                            ))}
                        </div>
                    ))}
                </section>
            )}

            <MeasurementLogDialog
                open={logFormOpen}
                onOpenChange={setLogFormOpen}
                log={editingLog}
                types={data.types}
                selectedType={selectedType}
                onSaved={handleLogSaved}
            />

            <MeasurementTypeDialog
                open={typeFormOpen}
                onOpenChange={setTypeFormOpen}
                type={editingType}
                logCount={editingType ? logCountByType.get(editingType.id) ?? 0 : 0}
                onSaved={handleTypeSaved}
            />

            <ConfirmDialog
                open={deleteLogTarget !== null}
                destructive
                busy={deleteLogTarget !== null && busyId === deleteLogTarget.log.id}
                title="Delete reading?"
                description={
                    deleteLogTarget && (
                        <span>
                            This <strong className="text-foreground">{deleteLogTarget.typeName}</strong>{" "}
                            reading will be removed from your history. This cannot be undone.
                        </span>
                    )
                }
                confirmLabel="Delete"
                onConfirm={() => void confirmDeleteLog()}
                onCancel={() => setDeleteLogTarget(null)}
            />

            <ConfirmDialog
                open={deleteTypeTarget !== null}
                destructive
                busy={deleteTypeTarget !== null && busyId === deleteTypeTarget.type.id}
                title="Delete tracker?"
                description={
                    deleteTypeTarget && (
                        <span>
                            Tracker <strong className="text-foreground">{deleteTypeTarget.type.name}</strong>{" "}
                            and its {deleteTypeTarget.logCount}{" "}
                            {deleteTypeTarget.logCount === 1 ? "reading" : "readings"} will be
                            removed. This cannot be undone.
                        </span>
                    )
                }
                confirmLabel="Delete"
                onConfirm={() => void confirmDeleteType()}
                onCancel={() => setDeleteTypeTarget(null)}
            />
        </div>
    );
}

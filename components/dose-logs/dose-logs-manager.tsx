"use client";

import * as React from "react";
import Link from "next/link";
import {AlertCircle, CheckCircle2, ClipboardList, Plus, Search, SearchX, X,} from "lucide-react";

import type {DoseLog} from "@/lib/db/types";
import {dateOnlyIso, formatRelativeDay, isSameLocalDay} from "@/lib/scheduling/dates";
import {deleteDoseLog} from "@/lib/scheduling/service";
import {cn} from "@/lib/utils";

import {ConfirmDialog} from "@/components/app/confirm-dialog";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "@/components/ui/select";
import {Skeleton} from "@/components/ui/skeleton";

import {medicationIndex, useTrackerData} from "@/components/scheduling/use-tracker-data";

import {DoseLogFormDialog} from "./dose-log-form-dialog";
import {DoseLogRow} from "./dose-log-row";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

type OriginFilter = "all" | "scheduled" | "adhoc";

type Feedback = { kind: "success" | "error"; message: string } | null;

interface DeleteTarget {
    log: DoseLog;
    medicationName: string | null;
}

/** One local-day group in the history list (newest day first). */
interface DayGroup {
    day: Date;
    logs: DoseLog[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Dose history surface: search/filter, a day-grouped list of every logged
 * dose (scheduled check-offs and one-offs) and the log/edit/delete dialogs.
 * Boots the local database via `useTrackerData` and reloads after each write.
 */
export function DoseLogsManager() {
    const {phase, data, reload} = useTrackerData();

    const [query, setQuery] = React.useState("");
    const [medicationFilter, setMedicationFilter] = React.useState("all");
    const [originFilter, setOriginFilter] = React.useState<OriginFilter>("all");

    const [feedback, setFeedback] = React.useState<Feedback>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const [formOpen, setFormOpen] = React.useState(false);
    const [editing, setEditing] = React.useState<DoseLog | null>(null);
    const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null);

    const reportError = React.useCallback((error: unknown, prefix: string) => {
        const message = error instanceof Error ? error.message : String(error);
        setFeedback({kind: "error", message: `${prefix}: ${message}`});
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

    const openCreate = React.useCallback(() => {
        setEditing(null);
        setFormOpen(true);
    }, []);

    const openEdit = React.useCallback((log: DoseLog) => {
        setEditing(log);
        setFormOpen(true);
    }, []);

    const medications = React.useMemo(
        () => medicationIndex(data.medications),
        [data.medications]
    );

    const handleDoseSaved = React.useCallback(
        (saved: DoseLog, mode: "created" | "updated") => {
            const name = medications.get(saved.medicationId)?.name;
            setFeedback({
                kind: "success",
                message:
                    mode === "created"
                        ? `${name ? `${name} ` : ""}dose logged.`
                        : "Dose updated.",
            });
            onChanged();
        },
        [medications, onChanged]
    );

    const requestDelete = React.useCallback(
        (log: DoseLog) => {
            setDeleteTarget({
                log,
                medicationName: medications.get(log.medicationId)?.name ?? null,
            });
        },
        [medications]
    );

    const confirmDelete = React.useCallback(async () => {
        if (!deleteTarget) return;
        setBusyId(deleteTarget.log.id);
        try {
            await deleteDoseLog(deleteTarget.log.id);
            setFeedback({kind: "success", message: "Dose log deleted."});
            setDeleteTarget(null);
            onChanged();
        } catch (error: unknown) {
            reportError(error, "Delete failed");
            setDeleteTarget(null);
        } finally {
            setBusyId(null);
        }
    }, [deleteTarget, onChanged, reportError]);

    // -- Derived view state ------------------------------------------------

    const summary = React.useMemo(() => {
        const scheduled = data.doseLogs.filter((log) => log.scheduleId !== undefined).length;
        return {total: data.doseLogs.length, scheduled};
    }, [data.doseLogs]);

    const groups = React.useMemo<DayGroup[]>(() => {
        const needle = query.trim().toLowerCase();
        const visible = data.doseLogs.filter((log) => {
            if (medicationFilter !== "all" && log.medicationId !== medicationFilter) {
                return false;
            }
            if (originFilter === "scheduled" && log.scheduleId === undefined) {
                return false;
            }
            if (originFilter === "adhoc" && log.scheduleId !== undefined) {
                return false;
            }
            if (needle === "") return true;
            const medication = medications.get(log.medicationId);
            return [medication?.name, log.injectionSite, log.notes]
                .filter(Boolean)
                .some((text) => text!.toLowerCase().includes(needle));
        });

        // `listDoseLogs` returns newest first, so grouping in order yields
        // newest day first; within a day the entries stay in log order.
        const result: DayGroup[] = [];
        for (const log of visible) {
            const instant = new Date(log.timestamp);
            const last = result[result.length - 1];
            if (!last || !isSameLocalDay(instant, last.day)) {
                result.push({day: instant, logs: [log]});
            } else {
                last.logs.push(log);
            }
        }
        return result;
    }, [data.doseLogs, medications, query, medicationFilter, originFilter]);

    const hasMedications = data.medications.length > 0;

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
                <Skeleton className="h-10 w-full rounded-xl"/>
                <Skeleton className="h-64 w-full rounded-xl"/>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Feedback line */}
            {feedback && (
                <p
                    role="status"
                    className={cn(
                        "flex items-center gap-1.5 text-sm",
                        feedback.kind === "success"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive"
                    )}
                >
                    {feedback.kind === "success" ? (
                        <CheckCircle2 className="size-4 shrink-0" aria-hidden/>
                    ) : (
                        <AlertCircle className="size-4 shrink-0" aria-hidden/>
                    )}
                    {feedback.message}
                    <button
                        type="button"
                        onClick={() => setFeedback(null)}
                        aria-label="Dismiss"
                        className="text-muted-foreground hover:text-foreground ml-1"
                    >
                        <X className="size-3.5" aria-hidden/>
                    </button>
                </p>
            )}

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-36 flex-1">
                    <Search
                        className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 my-auto size-4"
                        aria-hidden
                    />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search name, site or notes…"
                        aria-label="Search dose logs"
                        className="pl-9"
                    />
                </div>
                <Select value={medicationFilter} onValueChange={setMedicationFilter}>
                    <SelectTrigger aria-label="Filter by medication" className="w-36">
                        <SelectValue/>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All medications</SelectItem>
                        {data.medications.map((medication) => (
                            <SelectItem key={medication.id} value={medication.id}>
                                {medication.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select
                    value={originFilter}
                    onValueChange={(value) => setOriginFilter(value as OriginFilter)}
                >
                    <SelectTrigger aria-label="Filter by origin" className="w-36">
                        <SelectValue/>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All origins</SelectItem>
                        <SelectItem value="scheduled">From schedules</SelectItem>
                        <SelectItem value="adhoc">One-off doses</SelectItem>
                    </SelectContent>
                </Select>
                <Button onClick={openCreate} disabled={!hasMedications}>
                    <Plus className="size-4" aria-hidden/>
                    Log dose
                </Button>
            </div>

            {/* Summary chips */}
            <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="tabular-nums">
                    {summary.total} {summary.total === 1 ? "dose" : "doses"}
                </Badge>
                {summary.scheduled > 0 && (
                    <Badge variant="outline" className="tabular-nums">
                        {summary.scheduled} from schedules
                    </Badge>
                )}
            </div>

            {/* Day-grouped history */}
            {groups.length > 0 ? (
                <div className="flex flex-col gap-4">
                    {groups.map((group) => (
                        <section key={dateOnlyIso(group.day)} className="flex flex-col gap-2">
                            <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                                {formatRelativeDay(group.day)}
                            </h2>
                            <div className="flex flex-col gap-2">
                                {group.logs.map((log) => (
                                    <DoseLogRow
                                        key={log.id}
                                        log={log}
                                        medication={medications.get(log.medicationId) ?? null}
                                        onEdit={openEdit}
                                        onDelete={requestDelete}
                                        busy={busyId === log.id}
                                    />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            ) : data.doseLogs.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                        <div className="bg-muted rounded-full border p-3">
                            <ClipboardList className="text-muted-foreground size-6" aria-hidden/>
                        </div>
                        <div>
                            <p className="text-sm font-medium">No dose logs yet</p>
                            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                                {hasMedications
                                    ? "Log a one-off dose here, or check off scheduled doses from Today — both land in this history."
                                    : "Add a medication first, then log its doses."}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            <Button onClick={openCreate} disabled={!hasMedications}>
                                <Plus className="size-4" aria-hidden/>
                                Log a dose
                            </Button>
                            {!hasMedications && (
                                <Button asChild variant="outline">
                                    <Link href="/medications">Add a medication</Link>
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <div
                    className="text-muted-foreground flex items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-sm">
                    <SearchX className="size-4" aria-hidden/>
                    No dose logs match your search or filters.
                </div>
            )}

            <DoseLogFormDialog
                open={formOpen}
                onOpenChange={setFormOpen}
                log={editing}
                medications={data.medications}
                schedules={data.schedules}
                onSaved={handleDoseSaved}
            />

            <ConfirmDialog
                open={deleteTarget !== null}
                destructive
                busy={deleteTarget !== null && busyId === deleteTarget.log.id}
                title="Delete dose log?"
                description={
                    deleteTarget && (
                        <span>
                            The{" "}
                            <strong className="text-foreground">
                                {deleteTarget.medicationName ?? "dose"}
                            </strong>{" "}
                            record will be removed from your history. Inventory is not
                            affected. This cannot be undone.
                        </span>
                    )
                }
                confirmLabel="Delete"
                onConfirm={() => void confirmDelete()}
                onCancel={() => setDeleteTarget(null)}
            />
        </div>
    );
}

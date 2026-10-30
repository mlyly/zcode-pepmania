"use client";

import * as React from "react";
import Link from "next/link";
import {useRouter, useSearchParams} from "next/navigation";
import {AlertCircle, CalendarDays, CalendarRange, ListTodo, Plus,} from "lucide-react";

import type {Medication, Schedule} from "@/lib/db/types";
import {storageAwareMessage} from "@/lib/db/quota";
import {dateOnlyIso, localDateFromIso} from "@/lib/scheduling/dates";
import {deleteSchedule, setScheduleActive} from "@/lib/scheduling/service";
import {formatNumber} from "@/lib/units";
import {cn} from "@/lib/utils";

import {ConfirmDialog} from "@/components/app/confirm-dialog";
import {type Feedback, FeedbackLine} from "@/components/ui/feedback-line";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {Skeleton} from "@/components/ui/skeleton";

import {ScheduleCalendar} from "./schedule-calendar";
import {ScheduleFormDialog} from "./schedule-form-dialog";
import {ScheduleRow} from "./schedule-row";
import {TodayChecklist} from "./today-checklist";
import {medicationIndex, useTrackerData} from "./use-tracker-data";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

type TabId = "today" | "calendar" | "schedules";

interface DeleteTarget {
    schedule: Schedule;
    medicationName: string | null;
}

function parseDateParam(value: string | null): Date | null {
    if (!value) return null;
    const date = localDateFromIso(value);
    return date;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Full scheduling surface (AGENTS.md §5): the "Today's Doses" checklist,
 * the month calendar + agenda, and the schedule list with CRUD. Boots the
 * local database and owns data reloads + feedback for all three.
 */
export function SchedulesManager() {
    const {phase, data, reload} = useTrackerData();

    const [tab, setTab] = React.useState<TabId>("today");
    const [feedback, setFeedback] = React.useState<Feedback>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const [formOpen, setFormOpen] = React.useState(false);
    const [editing, setEditing] = React.useState<Schedule | null>(null);
    const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null);

    const router = useRouter();
    const searchParams = useSearchParams();
    const [selectedDate, setSelectedDate] = React.useState<Date>(() => new Date());

    // Deep-link support (?date=YYYY-MM-DD): while the URL carries a date it
    // wins over the local selection — derived, not effect-synced.
    const dateParam = searchParams.get("date");
    const urlDate = React.useMemo(() => parseDateParam(dateParam), [dateParam]);
    const effectiveDate = urlDate ?? selectedDate;

    const selectDate = React.useCallback(
        (date: Date) => {
            setSelectedDate(date);
            const iso = dateOnlyIso(date);
            const isToday = iso === dateOnlyIso(new Date());
            router.replace(isToday ? "/schedules" : `/schedules?date=${iso}`, {scroll: false});
        },
        [router]
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

    const openCreate = React.useCallback(() => {
        setEditing(null);
        setFormOpen(true);
    }, []);

    const openEdit = React.useCallback((schedule: Schedule) => {
        setEditing(schedule);
        setFormOpen(true);
    }, []);

    const handleScheduleSaved = React.useCallback(
        (schedule: Schedule, mode: "created" | "updated") => {
            setFeedback({
                kind: "success",
                message:
                    mode === "created"
                        ? "Schedule created — it will appear in Today and the calendar."
                        : "Schedule updated.",
            });
            onChanged();
        },
        [onChanged]
    );

    const requestDelete = React.useCallback(
        (schedule: Schedule) => {
            const medication = medicationIndex(data.medications).get(schedule.medicationId);
            setDeleteTarget({
                schedule,
                medicationName: medication?.name ?? null,
            });
        },
        [data.medications]
    );

    const confirmDelete = React.useCallback(async () => {
        if (!deleteTarget) return;
        setBusyId(deleteTarget.schedule.id);
        try {
            await deleteSchedule(deleteTarget.schedule.id);
            setFeedback({kind: "success", message: "Schedule deleted. Dose history was kept."});
            setDeleteTarget(null);
            onChanged();
        } catch (error: unknown) {
            reportError(error, "Delete failed");
            setDeleteTarget(null);
        } finally {
            setBusyId(null);
        }
    }, [deleteTarget, onChanged, reportError]);

    const handleToggleActive = React.useCallback(
        async (schedule: Schedule, active: boolean) => {
            setBusyId(schedule.id);
            try {
                await setScheduleActive(schedule.id, active);
                setFeedback({
                    kind: "success",
                    message: active ? "Schedule resumed." : "Schedule paused.",
                });
                onChanged();
            } catch (error: unknown) {
                reportError(error, "Could not change the schedule");
            } finally {
                setBusyId(null);
            }
        },
        [onChanged, reportError]
    );

    // -- Derived view state ------------------------------------------------

    const activeCount = data.schedules.filter((s) => s.active).length;
    const medications = medicationIndex(data.medications);

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

    const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
        {id: "today", label: "Today", icon: ListTodo},
        {id: "calendar", label: "Calendar", icon: CalendarRange},
        {id: "schedules", label: "Schedules", icon: CalendarDays},
    ];

    return (
        <div className="flex flex-col gap-3">
            {/* Feedback line */}
            <FeedbackLine feedback={feedback} onDismiss={() => setFeedback(null)}/>

            {/* Tab bar */}
            <div
                role="tablist"
                aria-label="Scheduling views"
                className="flex gap-1 rounded-lg border p-1"
            >
                {tabs.map(({id, label, icon: Icon}) => (
                    <button
                        key={id}
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => setTab(id)}
                        className={cn(
                            "tap inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                            tab === id
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        )}
                    >
                        <Icon className="size-4" aria-hidden/>
                        {label}
                    </button>
                ))}
            </div>

            {tab === "today" && (
                <TodayChecklist
                    data={data}
                    onChanged={onChanged}
                    onError={reportError}
                    busy={busyId !== null}
                    onManage={() => setTab("schedules")}
                />
            )}

            {tab === "calendar" && (
                <Card>
                    <CardContent className="px-4 py-4">
                        <ScheduleCalendar
                            data={data}
                            selectedDate={effectiveDate}
                            onSelectDate={selectDate}
                            onChanged={onChanged}
                            onError={reportError}
                            busy={busyId !== null}
                        />
                    </CardContent>
                </Card>
            )}

            {tab === "schedules" && (
                <SchedulesList
                    data={data}
                    medications={medications}
                    activeCount={activeCount}
                    onNew={openCreate}
                    onEdit={openEdit}
                    onDelete={requestDelete}
                    onToggleActive={(schedule, active) =>
                        void handleToggleActive(schedule, active)
                    }
                    busyId={busyId}
                    hasMedications={data.medications.length > 0}
                />
            )}

            <ScheduleFormDialog
                open={formOpen}
                onOpenChange={setFormOpen}
                schedule={editing}
                medications={data.medications}
                onSaved={handleScheduleSaved}
            />

            <ConfirmDialog
                open={deleteTarget !== null}
                destructive
                busy={deleteTarget !== null && busyId === deleteTarget.schedule.id}
                title="Delete schedule?"
                description={
                    deleteTarget && (
                        <span>
                            {deleteTarget.medicationName ? (
                                <>
                                    The{" "}
                                    <strong className="text-foreground">
                                        {deleteTarget.medicationName}
                                    </strong>{" "}
                                </>
                            ) : null}
                            schedule will stop generating doses. Logged dose history is kept —
                            only the recurring schedule is removed. This cannot be undone.
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

// ---------------------------------------------------------------------------
// Schedules list (tab content)
// ---------------------------------------------------------------------------

interface SchedulesListProps {
    data: ReturnType<typeof useTrackerData>["data"];
    medications: Map<string, Medication>;
    activeCount: number;
    onNew: () => void;
    onEdit: (schedule: Schedule) => void;
    onDelete: (schedule: Schedule) => void;
    onToggleActive: (schedule: Schedule, active: boolean) => void;
    busyId: string | null;
    hasMedications: boolean;
}

function SchedulesList({
                           data,
                           medications,
                           activeCount,
                           onNew,
                           onEdit,
                           onDelete,
                           onToggleActive,
                           busyId,
                           hasMedications,
                       }: SchedulesListProps) {
    // Time-of-day first, then by medication name for a daily-agenda feel.
    const ordered = React.useMemo(
        () =>
            [...data.schedules].sort(
                (a, b) =>
                    a.timeOfDay.localeCompare(b.timeOfDay) ||
                    (medications.get(a.medicationId)?.name ?? "")
                        .localeCompare(medications.get(b.medicationId)?.name ?? "")
            ),
        [data.schedules, medications]
    );

    if (data.schedules.length === 0) {
        return (
            <Card className="border-dashed">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <div className="bg-muted rounded-full border p-3">
                        <CalendarDays className="text-muted-foreground size-6" aria-hidden/>
                    </div>
                    <div>
                        <p className="text-sm font-medium">No schedules yet</p>
                        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                            {hasMedications
                                ? "Create a schedule for any of your medications to see it in Today and the calendar."
                                : "Add a medication first, then schedule its doses."}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button onClick={onNew} disabled={!hasMedications}>
                            <Plus className="size-4" aria-hidden/>
                            New schedule
                        </Button>
                        {!hasMedications && (
                            <Button asChild variant="outline">
                                <Link href="/medications">Add a medication</Link>
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onNew}>
                    <Plus className="size-4" aria-hidden/>
                    New schedule
                </Button>
                <Badge variant="secondary" className="tabular-nums">
                    {data.schedules.length} {data.schedules.length === 1 ? "schedule" : "schedules"}
                    {activeCount < data.schedules.length && ` · ${formatNumber(activeCount)} active`}
                </Badge>
            </div>
            {ordered.map((schedule) => (
                <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    medication={medications.get(schedule.medicationId) ?? null}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onToggleActive={onToggleActive}
                    busy={busyId === schedule.id}
                />
            ))}
        </div>
    );
}

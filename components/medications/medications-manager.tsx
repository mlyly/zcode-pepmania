"use client";

import * as React from "react";
import {AlertCircle, ArrowDownUp, Boxes, CheckCircle2, Plus, Search, SearchX, X,} from "lucide-react";

import {ConfirmDialog} from "@/components/app/confirm-dialog";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "@/components/ui/select";
import {Skeleton} from "@/components/ui/skeleton";
import {ensureDatabase, type Medication, type MedicationType, type Schedule} from "@/lib/db";
import {MEDICATION_TYPE_META, MEDICATION_TYPES} from "@/lib/medications/constants";
import {inventoryStatus} from "@/lib/medications/derived";
import {
    adjustInventory,
    countLinkedRecords,
    deleteMedication,
    type LinkedRecordCounts,
    listMedications,
    listSchedules,
} from "@/lib/medications/service";
import {cn} from "@/lib/utils";

import {MedicationCard} from "./medication-card";
import {MedicationFormDialog} from "./medication-form-dialog";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

type SortOption = "name" | "stock" | "updated";

const STATUS_SEVERITY: Record<"out" | "low" | "ok", number> = {
    out: 0,
    low: 1,
    ok: 2,
};

type Feedback = { kind: "success" | "error"; message: string } | null;

interface DeleteTarget {
    medication: Medication;
    linked: LinkedRecordCounts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Full medications surface: filters, inventory cards and CRUD dialogs. */
export function MedicationsManager() {
    const [dbState, setDbState] = React.useState<{
        phase: "loading" | "ready" | "error";
        message?: string;
    }>({phase: "loading"});

    const [medications, setMedications] = React.useState<Medication[]>([]);
    const [schedules, setSchedules] = React.useState<Schedule[]>([]);
    const [dataLoading, setDataLoading] = React.useState(true);

    const [query, setQuery] = React.useState("");
    const [typeFilter, setTypeFilter] = React.useState<"all" | MedicationType>("all");
    const [sortBy, setSortBy] = React.useState<SortOption>("name");

    const [formOpen, setFormOpen] = React.useState(false);
    const [editing, setEditing] = React.useState<Medication | null>(null);
    const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null);
    const [deleting, setDeleting] = React.useState(false);
    const [busyId, setBusyId] = React.useState<string | null>(null);
    const [feedback, setFeedback] = React.useState<Feedback>(null);

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

    const load = React.useCallback(async () => {
        setDataLoading(true);
        try {
            const [nextMedications, nextSchedules] = await Promise.all([
                listMedications(),
                listSchedules(),
            ]);
            setMedications(nextMedications);
            setSchedules(nextSchedules);
        } catch (error: unknown) {
            reportError(error, "Could not read local data");
        } finally {
            setDataLoading(false);
        }
    }, [reportError]);

    // Migration pipeline must complete before any table is touched.
    React.useEffect(() => {
        let active = true;
        ensureDatabase()
            .then(() => {
                if (active) {
                    setDbState({phase: "ready"});
                    return load();
                }
            })
            .catch((error: unknown) => {
                if (active) {
                    setDbState({
                        phase: "error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [load]);

    // -- Derived view state ------------------------------------------------

    const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = medications.filter((medication) => {
            const matchesType = typeFilter === "all" || medication.type === typeFilter;
            const matchesQuery =
                needle === "" || medication.name.toLowerCase().includes(needle);
            return matchesType && matchesQuery;
        });
        const sorted = [...filtered];
        switch (sortBy) {
            case "stock":
                sorted.sort(
                    (a, b) =>
                        STATUS_SEVERITY[inventoryStatus(a)] -
                        STATUS_SEVERITY[inventoryStatus(b)] ||
                        a.inventory.currentQuantity - b.inventory.currentQuantity ||
                        a.name.localeCompare(b.name)
                );
                break;
            case "updated":
                sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
                break;
            default:
                sorted.sort((a, b) => a.name.localeCompare(b.name));
        }
        return sorted;
    }, [medications, query, typeFilter, sortBy]);

    const summary = React.useMemo(() => {
        let low = 0;
        let out = 0;
        for (const medication of medications) {
            const status = inventoryStatus(medication);
            if (status === "low") low += 1;
            if (status === "out") out += 1;
        }
        return {total: medications.length, low, out};
    }, [medications]);

    // -- Handlers ----------------------------------------------------------

    const openCreate = React.useCallback(() => {
        setEditing(null);
        setFormOpen(true);
    }, []);

    const openEdit = React.useCallback((medication: Medication) => {
        setEditing(medication);
        setFormOpen(true);
    }, []);

    const handleSaved = React.useCallback(
        (medication: Medication, mode: "created" | "updated") => {
            setMedications((previous) => {
                const index = previous.findIndex((m) => m.id === medication.id);
                if (index === -1) return [...previous, medication];
                const next = [...previous];
                next[index] = medication;
                return next;
            });
            setFeedback({
                kind: "success",
                message:
                    mode === "created"
                        ? `${medication.name} added.`
                        : `${medication.name} updated.`,
            });
        },
        []
    );

    const requestDelete = React.useCallback(
        async (medication: Medication) => {
            try {
                const linked = await countLinkedRecords(medication.id);
                setDeleteTarget({medication, linked});
            } catch (error: unknown) {
                reportError(error, "Could not prepare delete");
            }
        },
        [reportError]
    );

    const confirmDelete = React.useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const {medication} = deleteTarget;
            const counts = await deleteMedication(medication.id);
            setMedications((previous) =>
                previous.filter((m) => m.id !== medication.id)
            );
            setSchedules((previous) =>
                previous.filter((s) => s.medicationId !== medication.id)
            );
            setFeedback({
                kind: "success",
                message:
                    `${medication.name} deleted` +
                    (counts.schedules + counts.doseLogs > 0
                        ? ` (incl. ${counts.schedules} ${
                            counts.schedules === 1 ? "schedule" : "schedules"
                        }, ${counts.doseLogs} ${
                            counts.doseLogs === 1 ? "dose log" : "dose logs"
                        })`
                        : ""),
            });
            setDeleteTarget(null);
        } catch (error: unknown) {
            reportError(error, "Delete failed");
            setDeleteTarget(null);
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, reportError]);

    const handleAdjust = React.useCallback(
        async (medication: Medication, quantityDelta: number, vialDelta: number) => {
            setBusyId(medication.id);
            try {
                const updated = await adjustInventory(
                    medication.id,
                    quantityDelta,
                    vialDelta
                );
                setMedications((previous) =>
                    previous.map((m) => (m.id === updated.id ? updated : m))
                );
            } catch (error: unknown) {
                reportError(error, "Could not adjust inventory");
            } finally {
                setBusyId(null);
            }
        },
        [reportError]
    );

    // -- Render ------------------------------------------------------------

    if (dbState.phase === "error") {
        return (
            <Card className="border-destructive/50">
                <CardContent className="text-destructive flex items-start gap-2 px-4 text-sm">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden/>
                    <span>Database error: {dbState.message}</span>
                </CardContent>
            </Card>
        );
    }

    if (dbState.phase === "loading") {
        return (
            <div className="flex flex-col gap-3">
                {Array.from({length: 3}, (_, i) => (
                    <Skeleton key={i} className="h-28 w-full rounded-xl"/>
                ))}
            </div>
        );
    }

    const deleteDescription = deleteTarget && (
        <span>
            <strong className="text-foreground">{deleteTarget.medication.name}</strong>{" "}
            and its inventory will be removed from this browser.
            {deleteTarget.linked.schedules + deleteTarget.linked.doseLogs > 0 && (
                <>
                    {" "}
                    This also permanently deletes{" "}
                    <strong className="text-foreground">
                        {deleteTarget.linked.schedules}
                    </strong>{" "}
                    {deleteTarget.linked.schedules === 1 ? "schedule" : "schedules"} and{" "}
                    <strong className="text-foreground">
                        {deleteTarget.linked.doseLogs}
                    </strong>{" "}
                    {deleteTarget.linked.doseLogs === 1 ? "dose log" : "dose logs"}{" "}
                    linked to it.
                </>
            )}{" "}
            This cannot be undone.
        </span>
    );

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
                        placeholder="Search medications…"
                        aria-label="Search medications"
                        className="pl-9"
                    />
                </div>
                <Select
                    value={typeFilter}
                    onValueChange={(value) =>
                        setTypeFilter(value as "all" | MedicationType)
                    }
                >
                    <SelectTrigger aria-label="Filter by type" className="w-32">
                        <SelectValue/>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All types</SelectItem>
                        {MEDICATION_TYPES.map((value) => (
                            <SelectItem key={value} value={value}>
                                {MEDICATION_TYPE_META[value].label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
                    <SelectTrigger aria-label="Sort order" className="w-44">
                        <ArrowDownUp className="size-4" aria-hidden/>
                        <SelectValue/>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="name">Name A–Z</SelectItem>
                        <SelectItem value="stock">Stock, lowest first</SelectItem>
                        <SelectItem value="updated">Recently updated</SelectItem>
                    </SelectContent>
                </Select>
                <Button onClick={openCreate}>
                    <Plus className="size-4" aria-hidden/>
                    Add
                </Button>
            </div>

            {/* Summary chips */}
            <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="tabular-nums">
                    {summary.total} {summary.total === 1 ? "medication" : "medications"}
                </Badge>
                {summary.low > 0 && (
                    <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-700 tabular-nums dark:bg-amber-500/15 dark:text-amber-300"
                    >
                        {summary.low} low stock
                    </Badge>
                )}
                {summary.out > 0 && (
                    <Badge variant="destructive" className="tabular-nums">
                        {summary.out} out
                    </Badge>
                )}
            </div>

            {/* List */}
            {dataLoading ? (
                <div className="flex flex-col gap-3">
                    {Array.from({length: 3}, (_, i) => (
                        <Skeleton key={i} className="h-28 w-full rounded-xl"/>
                    ))}
                </div>
            ) : visible.length > 0 ? (
                <div className="flex flex-col gap-3">
                    {visible.map((medication) => (
                        <MedicationCard
                            key={medication.id}
                            medication={medication}
                            schedules={schedules}
                            onEdit={openEdit}
                            onDelete={(med) => void requestDelete(med)}
                            onAdjust={(med, quantityDelta, vialDelta) =>
                                void handleAdjust(med, quantityDelta, vialDelta)
                            }
                            adjusting={busyId === medication.id}
                        />
                    ))}
                </div>
            ) : medications.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                        <div className="bg-muted rounded-full border p-3">
                            <Boxes className="text-muted-foreground size-6" aria-hidden/>
                        </div>
                        <div>
                            <p className="text-sm font-medium">No medications yet</p>
                            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                                Add your first medication or peptide to track stock,
                                low-stock alerts, reconstitutions and dose volumes.
                            </p>
                        </div>
                        <Button onClick={openCreate}>
                            <Plus className="size-4" aria-hidden/>
                            Add medication
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div
                    className="text-muted-foreground flex items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-sm">
                    <SearchX className="size-4" aria-hidden/>
                    No medications match your search or filter.
                </div>
            )}

            <MedicationFormDialog
                open={formOpen}
                onOpenChange={setFormOpen}
                medication={editing}
                schedules={schedules}
                onSaved={handleSaved}
            />

            <ConfirmDialog
                open={deleteTarget !== null}
                destructive
                busy={deleting}
                title="Delete medication?"
                description={deleteDescription ?? ""}
                confirmLabel="Delete"
                onConfirm={() => void confirmDelete()}
                onCancel={() => setDeleteTarget(null)}
            />
        </div>
    );
}

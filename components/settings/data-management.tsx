"use client";

import * as React from "react";
import {
    AlertCircle,
    CheckCircle2,
    Download,
    FileJson,
    FileLock,
    FileUp,
    Lock,
    RotateCcw,
    ShieldAlert,
    Trash2,
} from "lucide-react";

import {ConfirmDialog} from "@/components/app/confirm-dialog";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {
    buildExportPayload,
    decryptEnvelope,
    downloadJsonString,
    type EncryptedEnvelope,
    encryptJson,
    ensureDatabase,
    estimatePasswordStrength,
    exportFilename,
    type ExportPayload,
    type ExportStats,
    getExportStats,
    isEncryptedEnvelope,
    LATEST_SCHEMA_VERSION,
    summarizePayload,
    validateExportPayload,
    wipeAllLocalData,
    writeImportedPayload,
} from "@/lib/db";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

type Feedback =
    | { kind: "idle" }
    | { kind: "busy"; message: string }
    | { kind: "success"; message: string }
    | { kind: "error"; message: string };

function FeedbackLine({feedback}: { feedback: Feedback }) {
    if (feedback.kind === "idle") return null;
    if (feedback.kind === "success") {
        return (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden/>
                {feedback.message}
            </p>
        );
    }
    if (feedback.kind === "busy") {
        return (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <span
                    className="border-foreground border-t-transparent size-3.5 animate-spin rounded-full border-2"
                    aria-hidden
                />
                {feedback.message}
            </p>
        );
    }
    return (
        <p className="text-destructive flex items-start gap-1.5 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden/>
            {feedback.message}
        </p>
    );
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function RadioButton({
                         checked,
                         onChange,
                         title,
                         hint,
                         icon,
                         name,
                     }: {
    checked: boolean;
    onChange: () => void;
    title: string;
    hint: string;
    icon: React.ReactNode;
    name: string;
}) {
    return (
        <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                checked ? "border-ring bg-accent/40" : "hover:bg-accent/20"
            }`}
        >
            <input
                type="radio"
                name={name}
                checked={checked}
                onChange={onChange}
                className="accent-primary mt-0.5"
            />
            <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium">
                    {icon}
                    {title}
                </span>
                <span className="text-muted-foreground mt-1 block text-xs">{hint}</span>
            </span>
        </label>
    );
}

// ---------------------------------------------------------------------------
// Export card
// ---------------------------------------------------------------------------

const EXPORT_TABLES: { key: keyof ExportStats; label: string }[] = [
    {key: "medications", label: "Medications"},
    {key: "schedules", label: "Schedules"},
    {key: "doseLogs", label: "Dose logs"},
    {key: "measurementTypes", label: "Measurement types"},
    {key: "measurementLogs", label: "Measurement logs"},
];

function ExportCard({refreshSignal}: { refreshSignal: number }) {
    const [mode, setMode] = React.useState<"plain" | "encrypted">("encrypted");
    const [password, setPassword] = React.useState("");
    const [confirmPassword, setConfirmPassword] = React.useState("");
    const [feedback, setFeedback] = React.useState<Feedback>({kind: "idle"});
    const [stats, setStats] = React.useState<ExportStats | null>(null);

    React.useEffect(() => {
        let active = true;
        // Re-reads live counts on mount and whenever the parent signals that
        // data changed (e.g. after an import).
        getExportStats()
            .then((value) => {
                if (active) setStats(value);
            })
            .catch((error: unknown) => {
                if (active) setFeedback({kind: "error", message: errorMessage(error)});
            });
        return () => {
            active = false;
        };
    }, [refreshSignal]);

    const strength = React.useMemo(
        () => estimatePasswordStrength(password),
        [password]
    );
    const passwordsMatch = password === confirmPassword;
    const canExport =
        mode === "plain" || (password.length > 0 && passwordsMatch && strength.score >= 1);

    const handleExport = async () => {
        setFeedback({kind: "busy", message: "Building backup…"});
        try {
            const payload = await buildExportPayload();
            if (mode === "encrypted") {
                const envelope = await encryptJson(payload, password);
                downloadJsonString(
                    JSON.stringify(envelope, null, 2),
                    exportFilename(payload.exportedAt, true)
                );
            } else {
                downloadJsonString(
                    JSON.stringify(payload, null, 2),
                    exportFilename(payload.exportedAt, false)
                );
            }
            setFeedback({
                kind: "success",
                message:
                    mode === "encrypted"
                        ? "Backup downloaded — encrypted with your passphrase (AES-256-GCM)."
                        : "Backup downloaded as plain JSON — readable by anyone with the file.",
            });
        } catch (error: unknown) {
            setFeedback({kind: "error", message: errorMessage(error)});
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Download className="size-4" aria-hidden/>
                    Export backup
                </CardTitle>
                <CardDescription>
                    Download everything stored in this browser as a JSON file.
                    Files are generated entirely offline and never transmitted.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="grid gap-1.5 text-sm sm:grid-cols-2">
                    {stats
                        ? EXPORT_TABLES.map(({key, label}) => (
                            <div
                                key={key}
                                className="flex items-center justify-between rounded-md border px-3 py-1.5"
                            >
                                <span className="text-muted-foreground">{label}</span>
                                <span className="tabular-nums">{stats[key]}</span>
                            </div>
                        ))
                        : Array.from({length: EXPORT_TABLES.length}).map((_, i) => (
                            <div key={i} className="bg-muted h-9 animate-pulse rounded-md border"/>
                        ))}
                </div>

                <fieldset className="flex flex-col gap-2.5">
                    <legend className="sr-only">Backup format</legend>
                    <RadioButton
                        name="export-mode"
                        checked={mode === "plain"}
                        onChange={() => setMode("plain")}
                        icon={<FileJson className="size-4" aria-hidden/>}
                        title="Plain JSON"
                        hint="Maximum portability. Unencrypted — store the file somewhere safe."
                    />
                    <RadioButton
                        name="export-mode"
                        checked={mode === "encrypted"}
                        onChange={() => setMode("encrypted")}
                        icon={<FileLock className="size-4" aria-hidden/>}
                        title="Encrypted (recommended)"
                        hint="AES-256-GCM with a passphrase-derived key (PBKDF2, 600k iterations)."
                    />
                </fieldset>

                {mode === "encrypted" && (
                    <div className="flex flex-col gap-3 rounded-lg border p-3">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="export-password">Passphrase</Label>
                            <Input
                                id="export-password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                            {password && (
                                <>
                                    <div className="flex items-center gap-2 text-xs">
                                        <div className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                                            <div
                                                className={`size-full rounded-full transition-all ${
                                                    ["bg-red-500 w-1/4", "bg-red-500 w-1/4", "bg-amber-500 w-2/4", "bg-lime-500 w-3/4", "bg-emerald-500 w-full"][strength.score]
                                                }`}
                                            />
                                        </div>
                                        <span className="text-muted-foreground whitespace-nowrap">
                                            {strength.label}
                                        </span>
                                    </div>
                                    {strength.hints.length > 0 && (
                                        <p className="text-muted-foreground text-xs">
                                            Hints: {strength.hints.join(" · ")}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="export-password-confirm">Confirm passphrase</Label>
                            <Input
                                id="export-password-confirm"
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                aria-invalid={confirmPassword.length > 0 && !passwordsMatch}
                            />
                            {confirmPassword.length > 0 && !passwordsMatch && (
                                <p className="text-destructive text-xs">
                                    Passphrases do not match.
                                </p>
                            )}
                        </div>
                        <p className="text-muted-foreground text-xs">
                            A forgotten passphrase has <strong className="text-foreground">no
                            recovery</strong> — the key is derived locally and never stored.
                        </p>
                    </div>
                )}

                <div className="flex flex-col gap-2">
                    <Button
                        onClick={() => void handleExport()}
                        disabled={!canExport || feedback.kind === "busy"}
                    >
                        <Download className="size-4" aria-hidden/>
                        Download backup
                    </Button>
                    <FeedbackLine feedback={feedback}/>
                </div>
            </CardContent>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Import card
// ---------------------------------------------------------------------------

type ImportState =
    | { step: "idle"; name: null; envelope: null; payload: null }
    /** File read; contains an envelope that needs a passphrase to decrypt. */
    | { step: "encrypted"; name: string; envelope: EncryptedEnvelope; payload: null }
    /** Validated payload, awaiting mode choice + confirmation. */
    | { step: "ready"; name: string; envelope: null; payload: ExportPayload; encrypted: boolean };

type ImportMode = "merge" | "replace";

function ImportCard({onImported}: { onImported: () => void }) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [state, setState] = React.useState<ImportState>({
        step: "idle",
        name: null,
        envelope: null,
        payload: null,
    });
    const [passphrase, setPassphrase] = React.useState("");
    const [mode, setMode] = React.useState<ImportMode>("merge");
    const [feedback, setFeedback] = React.useState<Feedback>({kind: "idle"});
    const [confirmOpen, setConfirmOpen] = React.useState(false);

    const handleFilePicked = async (file: File | undefined) => {
        if (!file) return;
        setPassphrase("");
        setFeedback({kind: "busy", message: "Reading file…"});
        try {
            const raw = await file.text();
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // Falls through: validateExportPayload reports a precise error.
            }

            if (isEncryptedEnvelope(parsed)) {
                setState({step: "encrypted", name: file.name, envelope: parsed, payload: null});
                setFeedback({kind: "idle"});
                return;
            }

            const payload = await validateExportPayload(raw);
            setState({
                step: "ready",
                name: file.name,
                envelope: null,
                payload,
                encrypted: false,
            });
            setFeedback({kind: "idle"});
        } catch (error: unknown) {
            setState({step: "idle", name: null, envelope: null, payload: null});
            setFeedback({kind: "error", message: `Cannot import: ${errorMessage(error)}`});
        }
    };

    const handleDecrypt = async () => {
        if (state.step !== "encrypted") return;
        setFeedback({kind: "busy", message: "Decrypting (PBKDF2, 600k iterations)…"});
        try {
            const raw = await decryptEnvelope(state.envelope, passphrase);
            setFeedback({kind: "busy", message: "Validating payload…"});
            const payload = await validateExportPayload(raw);
            setState({
                step: "ready",
                name: state.name,
                envelope: null,
                payload,
                encrypted: true,
            });
            setFeedback({kind: "idle"});
        } catch (error: unknown) {
            setFeedback({kind: "error", message: errorMessage(error)});
        }
    };

    const handleConfirmImport = async () => {
        if (state.step !== "ready") return;
        setConfirmOpen(false);
        setFeedback({kind: "busy", message: "Writing data…"});
        try {
            await writeImportedPayload(state.payload, mode);
            const {counts} = summarizePayload(state.payload);
            const total = counts.medications + counts.schedules + counts.doseLogs +
                counts.measurementTypes + counts.measurementLogs;
            setFeedback({
                kind: "success",
                message: mode === "replace"
                    ? `Imported (replace) — restored ${total} records from the backup.`
                    : `Imported (merge) — ${total} records written; existing entries were kept unless the file overrode them.`,
            });
            onImported();
        } catch (error: unknown) {
            setFeedback({kind: "error", message: `Import failed: ${errorMessage(error)}`});
        }
    };

    const summary = state.step === "ready" ? summarizePayload(state.payload) : null;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <FileUp className="size-4" aria-hidden/>
                    Import backup
                </CardTitle>
                <CardDescription>
                    Validate a previously exported file (checksum + schema version),
                    then merge it into — or replace — the data in this browser.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json,.enc.json"
                    className="sr-only"
                    onChange={(e) => {
                        void handleFilePicked(e.target.files?.[0]);
                        e.target.value = ""; // allow re-selecting the same file
                    }}
                />
                <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={feedback.kind === "busy"}
                >
                    <FileUp className="size-4" aria-hidden/>
                    {state.step === "idle" ? "Choose backup file…" : "Choose another file…"}
                </Button>
                {state.step !== "idle" && state.name && (
                    <p className="text-muted-foreground truncate text-xs">
                        {state.name}
                        {state.step === "encrypted" && " · encrypted"}
                        {state.step === "ready" && state.encrypted && " · encrypted"}
                    </p>
                )}

                {state.step === "encrypted" && (
                    <div className="flex flex-col gap-2 rounded-lg border p-3">
                        <Label htmlFor="import-passphrase">Backup passphrase</Label>
                        <Input
                            id="import-passphrase"
                            type="password"
                            autoComplete="off"
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && passphrase) void handleDecrypt();
                            }}
                        />
                        <Button
                            size="sm"
                            onClick={() => void handleDecrypt()}
                            disabled={!passphrase}
                        >
                            <Lock className="size-4" aria-hidden/>
                            Decrypt
                        </Button>
                    </div>
                )}

                {state.step === "ready" && summary && (
                    <>
                        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="secondary">Checksum verified</Badge>
                                <Badge variant="secondary">
                                    Schema v{summary.schemaVersion} → v{LATEST_SCHEMA_VERSION}
                                </Badge>
                                {state.encrypted && <Badge variant="secondary">Decrypted</Badge>}
                                <span className="text-muted-foreground">
                                    Exported {summary.exportedAt.slice(0, 10)}
                                </span>
                            </div>
                            <div className="text-muted-foreground">
                                {summary.counts.medications} medications ·{" "}
                                {summary.counts.schedules} schedules ·{" "}
                                {summary.counts.doseLogs} dose logs ·{" "}
                                {summary.counts.measurementTypes} measurement types ·{" "}
                                {summary.counts.measurementLogs} measurement logs
                            </div>
                        </div>

                        <fieldset className="flex flex-col gap-2.5">
                            <legend className="sr-only">Import mode</legend>
                            <RadioButton
                                name="import-mode"
                                checked={mode === "merge"}
                                onChange={() => setMode("merge")}
                                icon={<RotateCcw className="size-4" aria-hidden/>}
                                title="Merge (recommended)"
                                hint="Keep current data; entries in the file overwrite records with the same ID."
                            />
                            <RadioButton
                                name="import-mode"
                                checked={mode === "replace"}
                                onChange={() => setMode("replace")}
                                icon={<AlertCircle className="size-4" aria-hidden/>}
                                title="Replace"
                                hint="Delete all current data first, then restore only what is in the file."
                            />
                        </fieldset>

                        <Button
                            onClick={() => setConfirmOpen(true)}
                            variant={mode === "replace" ? "destructive" : "default"}
                        >
                            {mode === "replace" ? "Replace current data…" : "Merge data…"}
                        </Button>
                    </>
                )}

                <FeedbackLine feedback={feedback}/>
            </CardContent>

            {state.step === "ready" && (
                <ConfirmDialog
                    open={confirmOpen}
                    destructive={mode === "replace"}
                    title={mode === "replace" ? "Replace all current data?" : "Import this backup?"}
                    description={
                        mode === "replace"
                            ? "Every medication, schedule, dose log and measurement currently stored in this browser will be deleted before the backup is restored. This cannot be undone."
                            : "Records from the file will be written into this browser. Existing records are kept unless the file contains entries with the same ID."
                    }
                    confirmLabel={mode === "replace" ? "Delete & restore" : "Import"}
                    busy={feedback.kind === "busy"}
                    onConfirm={() => void handleConfirmImport()}
                    onCancel={() => setConfirmOpen(false)}
                />
            )}
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Danger zone card
// ---------------------------------------------------------------------------

const WIPE_PHRASE = "WIPE";

function DangerZoneCard() {
    const [confirmOpen, setConfirmOpen] = React.useState(false);
    const [feedback, setFeedback] = React.useState<Feedback>({kind: "idle"});

    const handleWipe = async () => {
        setConfirmOpen(false);
        setFeedback({kind: "busy", message: "Erasing local data…"});
        try {
            await wipeAllLocalData();
            setFeedback({kind: "busy", message: "Local data erased. Reloading…"});
            window.setTimeout(() => window.location.reload(), 800);
        } catch (error: unknown) {
            setFeedback({kind: "error", message: `Wipe failed: ${errorMessage(error)}`});
        }
    };

    return (
        <Card className="border-destructive/50">
            <CardHeader>
                <CardTitle className="text-destructive flex items-center gap-2 text-base">
                    <ShieldAlert className="size-4" aria-hidden/>
                    Danger zone
                </CardTitle>
                <CardDescription>
                    Permanently delete everything this app stores in this browser:
                    medications, schedules, logs, measurements, backups, the cached
                    app shell and the offline service worker. The app reloads empty.
                    Nothing is transmitted anywhere at any point.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
                    <Trash2 className="size-4" aria-hidden/>
                    Wipe all local data…
                </Button>
                <p className="text-muted-foreground text-xs">
                    Export a backup first if you might want this data later.
                </p>
                <FeedbackLine feedback={feedback}/>
            </CardContent>

            <ConfirmDialog
                open={confirmOpen}
                destructive
                busy={feedback.kind === "busy"}
                title="Wipe everything from this browser?"
                description="All Peptimania data in IndexedDB, localStorage, sessionStorage and the offline cache will be deleted. This cannot be undone."
                confirmLabel="Erase everything"
                requirePhrase={WIPE_PHRASE}
                requirePhraseLabel={`Type ${WIPE_PHRASE} to confirm`}
                onConfirm={() => void handleWipe()}
                onCancel={() => setConfirmOpen(false)}
            />
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The complete Privacy & Data Management settings surface. */
export function DataManagement() {
    const [dbReady, setDbReady] = React.useState(false);
    const [dbError, setDbError] = React.useState<Error | null>(null);
    const [statsSignal, setStatsSignal] = React.useState(0);
    const bumpStats = React.useCallback(() => setStatsSignal((n) => n + 1), []);

    // The migration pipeline must complete before any table is touched
    // (mirrors the StorageStatus card rendered above this one on Settings).
    React.useEffect(() => {
        let active = true;
        ensureDatabase()
            .then(() => {
                if (active) setDbReady(true);
            })
            .catch((error: unknown) => {
                if (active) {
                    setDbError(error instanceof Error ? error : new Error(String(error)));
                }
            });
        return () => {
            active = false;
        };
    }, []);

    if (dbError) {
        return (
            <p className="text-destructive text-sm">
                Database error: {dbError.message}
            </p>
        );
    }

    if (!dbReady) {
        return (
            <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                <span
                    className="border-foreground border-t-transparent size-3.5 animate-spin rounded-full border-2"
                    aria-hidden
                />
                Opening local database…
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <ExportCard refreshSignal={statsSignal}/>
            <ImportCard onImported={bumpStats}/>
            <DangerZoneCard/>
        </div>
    );
}

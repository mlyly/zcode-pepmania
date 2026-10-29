"use client";

import * as React from "react";
import {AlertTriangle} from "lucide-react";

import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";

export interface ConfirmDialogProps {
    open: boolean;
    title: string;
    description: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Use the destructive styling and add a warning icon. */
    destructive?: boolean;
    /** Require the user to type this exact phrase before confirming. */
    requirePhrase?: string;
    requirePhraseLabel?: string;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Lightweight confirmation modal (no Radix dialog dependency). Accessible
 * alertdialog semantics, Escape to cancel, autofocused non-destructive button.
 */
export function ConfirmDialog({
                                  open,
                                  title,
                                  description,
                                  confirmLabel = "Confirm",
                                  cancelLabel = "Cancel",
                                  destructive = false,
                                  requirePhrase,
                                  requirePhraseLabel,
                                  busy = false,
                                  onConfirm,
                                  onCancel,
                              }: ConfirmDialogProps) {
    const [phrase, setPhrase] = React.useState("");
    const cancelRef = React.useRef<HTMLButtonElement>(null);

    React.useEffect(() => {
        const timer = window.setTimeout(() => cancelRef.current?.focus());
        return () => window.clearTimeout(timer);
    }, [open]);

    React.useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !busy) onCancel();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, busy, onCancel]);

    if (!open) return null;

    // Keying on `open` remounts the panel each time it opens, so the typed
    // phrase (and any focus state) starts fresh without effect-driven setState.
    const phraseSatisfied = !requirePhrase || phrase === requirePhrase;

    return (
        <div
            key="confirm-dialog-panel"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !busy) onCancel();
            }}
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                aria-describedby="confirm-dialog-description"
                className="bg-card w-full max-w-md rounded-xl border p-5 shadow-lg"
            >
                <div className="flex items-start gap-3">
                    {destructive && (
                        <AlertTriangle
                            className="text-destructive mt-0.5 size-5 shrink-0"
                            aria-hidden
                        />
                    )}
                    <div className="min-w-0">
                        <h2
                            id="confirm-dialog-title"
                            className="text-base font-semibold"
                        >
                            {title}
                        </h2>
                        <div
                            id="confirm-dialog-description"
                            className="text-muted-foreground mt-1.5 text-sm"
                        >
                            {description}
                        </div>
                    </div>
                </div>

                {requirePhrase && (
                    <div className="mt-4">
                        {requirePhraseLabel && (
                            <p className="text-muted-foreground mb-1.5 text-xs">
                                {requirePhraseLabel}
                            </p>
                        )}
                        <input
                            type="text"
                            value={phrase}
                            onChange={(event) => setPhrase(event.target.value)}
                            aria-label={`Type ${requirePhrase} to confirm`}
                            autoComplete="off"
                            spellCheck={false}
                            className={cn(
                                "flex h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                                phrase.length > 0 && phrase !== requirePhrase
                                    ? "border-destructive"
                                    : ""
                            )}
                        />
                    </div>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <Button
                        ref={cancelRef}
                        variant="outline"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        {cancelLabel}
                    </Button>
                    <Button
                        variant={destructive ? "destructive" : "default"}
                        onClick={onConfirm}
                        disabled={!phraseSatisfied || busy}
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}

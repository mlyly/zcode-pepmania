import {cn} from "@/lib/utils";
import {AlertCircle, CheckCircle2, X} from "lucide-react";

export type Feedback = { kind: "success" | "error"; message: string } | null;

/**
 * Shared inline status line used by the data managers: auto-dismissing
 * success, persistent (dismissible) error, announced via aria-live.
 */
export function FeedbackLine({
                                 feedback,
                                 onDismiss,
                             }: {
    feedback: Feedback;
    onDismiss: () => void;
}) {
    if (!feedback) return null;
    return (
        <p
            role="status"
            aria-live={feedback.kind === "error" ? "assertive" : "polite"}
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
                onClick={onDismiss}
                aria-label="Dismiss"
                className="tap text-muted-foreground hover:text-foreground ml-1 inline-flex items-center justify-center px-1"
            >
                <X className="size-3.5" aria-hidden/>
            </button>
        </p>
    );
}

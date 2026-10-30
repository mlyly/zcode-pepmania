"use client";

import {useRouter} from "next/navigation";
import {ChevronLeft} from "lucide-react";

import {Button} from "@/components/ui/button";

/**
 * "<" back navigation for sub-pages.
 *
 * Uses the browser history stack (`router.back()`) so it returns to whichever
 * page the user transferred from — the dashboard, another sub-page, or an
 * in-page link. If the user landed on this page directly (deep link / fresh
 * tab with nothing behind it), it falls back to the given href instead of
 * leaving the app.
 */
export function BackButton({fallbackHref = "/"}: { fallbackHref?: string }) {
    const router = useRouter();

    return (
        <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => {
                if (window.history.length > 1) {
                    router.back();
                } else {
                    router.push(fallbackHref);
                }
            }}
        >
            <ChevronLeft className="size-4" aria-hidden/>
            Back
        </Button>
    );
}

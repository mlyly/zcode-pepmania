"use client";

import {useRouter} from "next/navigation";
import {ChevronLeft} from "lucide-react";

import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";

/**
 * "<" back navigation for sub-pages, placed inline before the page title.
 *
 * Uses the browser history stack (`router.back()`) so it returns to whichever
 * page the user transferred from — the dashboard, another sub-page, or an
 * in-page link. If the user landed on this page directly (deep link / fresh
 * tab with nothing behind it), it falls back to the given href instead of
 * leaving the app.
 */
export function BackButton({
                               fallbackHref = "/",
                               className,
                           }: {
    fallbackHref?: string;
    className?: string;
}) {
    const router = useRouter();

    return (
        <Button
            variant="ghost"
            size="sm"
            aria-label="Back"
            className={cn("-ml-2", className)}
            onClick={() => {
                if (window.history.length > 1) {
                    router.back();
                } else {
                    router.push(fallbackHref);
                }
            }}
        >
            <ChevronLeft className="size-5" aria-hidden/>
        </Button>
    );
}

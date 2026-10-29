import type {Metadata} from "next";
import {Suspense} from "react";

import {StatusBadges} from "@/components/app/storage-status";
import {SchedulesManager} from "@/components/scheduling/schedules-manager";
import {Skeleton} from "@/components/ui/skeleton";

export const metadata: Metadata = {
    title: "Schedules",
    description:
        "Dose schedules with daily, weekly and custom-interval frequencies — check off today's doses, browse the calendar agenda, and manage recurring doses. 100% local.",
};

export default function SchedulesPage() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
            <header className="flex w-full max-w-3xl flex-col gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
                <p className="text-muted-foreground max-w-2xl">
                    Set how often and when to take each medication — daily, on specific
                    weekdays, or every N days. Check off today’s doses in one tap, or browse
                    the calendar. Everything stays in this browser.
                </p>
                <StatusBadges/>
            </header>

            <main className="flex w-full max-w-3xl flex-col gap-4">
                {/*
                    Suspense is required: the manager reads `?date=` via
                    useSearchParams, which must be client-side rendered in a
                    static export (Next 16). The shell above stays in the
                    initial HTML.
                */}
                <Suspense
                    fallback={<Skeleton className="h-72 w-full rounded-xl"/>}
                >
                    <SchedulesManager/>
                </Suspense>
            </main>
        </div>
    );
}

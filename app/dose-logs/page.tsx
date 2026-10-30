import type {Metadata} from "next";

import {BackButton} from "@/components/app/back-button";
import {StatusBadges} from "@/components/app/storage-status";
import {DoseLogsManager} from "@/components/dose-logs/dose-logs-manager";

export const metadata: Metadata = {
    title: "Dose Log",
    description:
        "Every dose you've recorded — scheduled check-offs and one-offs — with times, amounts, sites and notes, in a day-grouped history. 100% local.",
};

export default function DoseLogsPage() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
            <header className="flex w-full max-w-3xl flex-col gap-3">
                <BackButton/>
                <h1 className="text-2xl font-semibold tracking-tight">Dose Log</h1>
                <p className="text-muted-foreground max-w-2xl">
                    Your complete dose history — scheduled check-offs and one-off doses,
                    with exact times, amounts, sites and notes. Search, filter, edit or
                    delete any entry. Everything stays in this browser.
                </p>
                <StatusBadges/>
            </header>

            <main className="flex w-full max-w-3xl flex-col gap-4">
                <DoseLogsManager/>
            </main>
        </div>
    );
}

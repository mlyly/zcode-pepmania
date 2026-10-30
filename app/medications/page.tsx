import type {Metadata} from "next";

import {BackButton} from "@/components/app/back-button";
import {StatusBadges} from "@/components/app/storage-status";
import {MedicationsManager} from "@/components/medications/medications-manager";

export const metadata: Metadata = {
    title: "Medications",
    description:
        "Manage medications, peptides and supplements — inventory, low-stock alerts, reconstitutions and schedule-linked dose volumes. 100% local.",
};

export default function MedicationsPage() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
            <header className="flex w-full max-w-3xl flex-col gap-3">
                <BackButton/>
                <h1 className="text-2xl font-semibold tracking-tight">Medications</h1>
                <p className="text-muted-foreground max-w-2xl">
                    Track what you stock, what you’re running low on, and exactly how
                    much to draw for each scheduled dose. Everything stays in this
                    browser.
                </p>
                <StatusBadges/>
            </header>

            <main className="flex w-full max-w-3xl flex-col gap-4">
                <MedicationsManager/>
            </main>
        </div>
    );
}

import type {Metadata} from "next";

import {StatusBadges} from "@/components/app/storage-status";
import {DataManagement} from "@/components/settings/data-management";

export const metadata: Metadata = {
    title: "Settings",
    description:
        "Privacy and data management — export, import or wipe all locally stored data. 100% client-side.",
};

export default function SettingsPage() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
            <header className="flex w-full max-w-2xl flex-col gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
                <p className="text-muted-foreground max-w-xl">
                    Your data lives only in this browser (IndexedDB) — export, import
                    or erase it — and nothing ever leaves your device.
                </p>
                <StatusBadges/>
            </header>

            <main className="flex w-full max-w-2xl flex-col gap-4">
                <DataManagement/>
            </main>
        </div>
    );
}

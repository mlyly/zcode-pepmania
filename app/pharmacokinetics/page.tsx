import type {Metadata} from "next";

import {StatusBadges} from "@/components/app/storage-status";
import {PkChartDashboard} from "@/components/pharmacokinetics/pk-chart-dashboard";

export const metadata: Metadata = {
    title: "Concentration Chart",
    description:
        "Interactive pharmacokinetic concentration curves with multi-medication overlays, calendar windows and mcg/mg/IU display units. 100% local.",
};

export default function PharmacokineticsPage() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
            <header className="flex w-full max-w-5xl flex-col gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">
                    Concentration Chart
                </h1>
                <p className="text-muted-foreground max-w-2xl">
                    Estimated first-order elimination curves built from your logged and
                    scheduled doses. Toggle medications, switch the window and convert the
                    axes and tooltips between mcg, mg and IU — all in this browser.
                </p>
                <StatusBadges/>
            </header>

            <main className="flex w-full max-w-5xl flex-col gap-4">
                <PkChartDashboard/>
            </main>
        </div>
    );
}

import Link from "next/link";
import {Activity, CalendarCheck2, ChartSpline, ClipboardList, Pill, Settings} from "lucide-react";

import {Button} from "@/components/ui/button";
import {DashboardChecklist} from "@/components/scheduling/dashboard-checklist";

export default function Home() {
  return (
      <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
          <header className="flex w-full max-w-3xl flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight">
                      Peptimania
                  </h1>
                  <nav className="flex flex-wrap items-center justify-end gap-1">
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/schedules">
                              <CalendarCheck2 className="size-4" aria-hidden/>
                              Schedules
                          </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/medications">
                              <Pill className="size-4" aria-hidden/>
                              Medications
                          </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/dose-logs">
                              <ClipboardList className="size-4" aria-hidden/>
                              Dose Log
                          </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/pharmacokinetics">
                              <ChartSpline className="size-4" aria-hidden/>
                              Chart
                          </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/measurements">
                              <Activity className="size-4" aria-hidden/>
                              Metrics
                          </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                          <Link href="/settings">
                              <Settings className="size-4" aria-hidden/>
                              Settings
                          </Link>
                      </Button>
                  </nav>
              </div>
              <p className="text-muted-foreground max-w-2xl">
                  A privacy-first peptide &amp; medication tracker. Everything runs in
                  your browser and keeps working offline.
              </p>
          </header>

          <main className="flex w-full max-w-3xl flex-col gap-4">
              {/* Live "Today's Doses" checklist (Quick Log) — the dashboard's
                  working module. Boots the local DB itself. */}
              <DashboardChecklist manageHref="/schedules"/>
      </main>
    </div>
  );
}

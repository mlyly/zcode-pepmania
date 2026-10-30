import Link from "next/link";
import {ArrowUpRight, CalendarCheck2, ClipboardList, Pill, Settings} from "lucide-react";

import {Button} from "@/components/ui/button";
import {StatusBadges, StorageStatus} from "@/components/app/storage-status";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {DashboardChecklist} from "@/components/scheduling/dashboard-checklist";

const modules: {
    title: string;
    description: string;
    /** Route for implemented modules; planned ones render without a link. */
    href?: "/medications" | "/schedules" | "/dose-logs";
}[] = [
    {
        title: "Quick Log",
        description: "One-tap completion of today's scheduled doses, with make-up logging.",
        href: "/schedules",
    },
    {
        title: "Active Inventory",
        description: "Compact status cards with low-stock badges.",
        href: "/medications",
    },
    {
        title: "Dose Log",
        description: "Day-grouped history of every logged dose — search, filter, edit and re-time.",
        href: "/dose-logs",
    },
    {title: "Pharmacokinetics", description: "Concentration decay curves, multi-medication overlay."},
    {title: "Body Metrics", description: "Custom measurements with quick logging."},
];

export default function Home() {
  return (
      <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
          <header className="flex w-full max-w-3xl flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight">
                      Peptimania
                  </h1>
                  <nav className="flex items-center gap-1">
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
              <StatusBadges/>
          </header>

          <main className="flex w-full max-w-3xl flex-col gap-4">
              <StorageStatus/>

              {/* Live "Today's Doses" checklist (Quick Log) — the dashboard's
                  working module. Boots the local DB itself. */}
              <DashboardChecklist manageHref="/schedules"/>

              <Card>
                  <CardHeader>
                      <CardTitle className="text-base">Dashboard modules</CardTitle>
                      <CardDescription>
                          The tracker’s surface — inventory and scheduling are live, the
                          rest is coming.
                      </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                      {modules.map((m) => {
                          const body = (
                              <>
                                  <p className="text-sm font-medium">{m.title}</p>
                                  <p className="text-muted-foreground mt-1 text-sm">
                                      {m.description}
                                  </p>
                              </>
                          );
                          return m.href ? (
                              <Link
                                  key={m.title}
                                  href={m.href}
                                  className="rounded-lg border p-3 transition-colors hover:bg-accent/50"
                              >
                                  <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0">{body}</div>
                                      <ArrowUpRight
                                          className="text-muted-foreground size-4 shrink-0"
                                          aria-hidden
                                      />
                                  </div>
                              </Link>
                          ) : (
                              <div key={m.title} className="rounded-lg border p-3">
                                  {body}
                              </div>
                          );
                      })}
                  </CardContent>
              </Card>
      </main>
    </div>
  );
}

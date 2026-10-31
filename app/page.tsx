import {HomeNav} from "@/components/app/home-nav";
import {DashboardChecklist} from "@/components/scheduling/dashboard-checklist";

export default function Home() {
  return (
      <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
          <header className="flex w-full max-w-3xl flex-col gap-3">
              <div className="flex items-center gap-3">
                  <h1 className="shrink-0 text-2xl font-semibold tracking-tight">
                      Peptimania
                  </h1>
                  <HomeNav/>
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

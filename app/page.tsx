import {StatusBadges, StorageStatus} from "@/components/app/storage-status";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";

const modules = [
    {title: "Quick Log", description: "One-tap completion of today's scheduled doses."},
    {title: "Active Inventory", description: "Compact status cards with low-stock badges."},
    {title: "Pharmacokinetics", description: "Concentration decay curves, multi-medication overlay."},
    {title: "Body Metrics", description: "Custom measurements with quick logging."},
];

export default function Home() {
  return (
      <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
          <header className="flex w-full max-w-3xl flex-col gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                  Peptimania
              </h1>
              <p className="text-muted-foreground max-w-2xl">
                  A privacy-first peptide &amp; medication tracker. Everything runs in
                  your browser and keeps working offline.
              </p>
              <StatusBadges/>
          </header>

          <main className="flex w-full max-w-3xl flex-col gap-4">
              <StorageStatus/>

              <Card>
                  <CardHeader>
                      <CardTitle className="text-base">Dashboard modules</CardTitle>
                      <CardDescription>
                          Planned surface for the tracker — infrastructure is in place.
                      </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                      {modules.map((m) => (
                          <div key={m.title} className="rounded-lg border p-3">
                              <p className="text-sm font-medium">{m.title}</p>
                              <p className="text-muted-foreground mt-1 text-sm">{m.description}</p>
                          </div>
                      ))}
                  </CardContent>
              </Card>
      </main>
    </div>
  );
}

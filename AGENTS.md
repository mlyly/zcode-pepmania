# AGENTS.md - Peptide & Medication Tracker (PWA)

## Project Overview

A privacy-first, offline-capable Progressive Web Application (PWA) built with Next.js, React, and Tailwind CSS / shadcn
components. The application tracks medications/peptides, inventory, scheduling, dose logs, pharmacokinetic concentration
models, reconstitutions, and customizable body metrics.

All data resides strictly in browser local storage (e.g., IndexedDB / LocalStorage). No data is transmitted to external
servers.

---

## 1. Tech Stack & Architecture

- **Framework**: Next.js (App Router, Static Export `output: 'export'`)
  NOTE: This is NOT the Next.js you know, breaking changes — APIs, conventions, and file structure may all
  differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
  (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root)
  before writing any code. Heed deprecation notices.
- **UI & Components**: React, Tailwind CSS, shadcn/ui (Radix UI primitives), Lucide React icons
- **State & Storage**: IndexedDB (via `idb` or `Dexie.js`) for local persistence; LocalStorage for lightweight user
  preferences.
- **Charts**: Recharts or Chart.js for concentration decay curves and metrics tracking.
- **PWA & Offline**: `next-pwa` or custom Service Worker with Cache Storage API.
- **Form Handling**: React Hook Form + Zod schema validation.

---

## 2. Privacy & Data Management

### 2.1 Storage Policy

- **Local Only**: Zero server calls or external API dependencies for storing user data.
- **Data Export**: JSON file export with version metadata and payload checksum.
- **Data Import**: File reader validation with migration checks before database replacement/merging.

### 2.2 Schema Migration System

To handle future app updates without breaking user data:

- Database must maintain a `schema_version` integer in storage metadata.
- Implement an explicit migration pipeline:
  ```ts
  type Migration = {
    version: number;
    up: (db: IDBPDatabase) => Promise<void>;
  };
  ```
- On initial load, execute `runMigrations(currentVersion, latestVersion)` sequentially.

---

## 3. Data Schema Specifications

### 3.1 Medication & Inventory

> **v2:** types are granular (`peptide`/`injection`/`pill`/`liquid`/`supplement`/`other`),
> dose units include `mL`, and the v1 → v2 migration (see `lib/db/migrations.ts`) remaps the
> legacy generic `"medication"` type to `"pill"`, preserving an automatic pre-migration backup.
>
> **v6:** the single aggregate inventory becomes a list of purchase/delivery lots.
> Each lot stores containers on hand, content per container, order/delivery dates, vendor,
> COA links and notes. Totals are always derived from the lots; the v5 → v6 migration folds
> the legacy inventory into one synthetic lot.
>
> **v7 (current):** each lot gains an optional `pricePerContainer` (USD per vial/container,
> not per content unit). Lot value = `vialCount × pricePerContainer`; medication value = the
> sum of priced lots (unpriced lots are excluded). Additive, so the v6 → v7 migration is a
> no-op.

```ts
type MassUnit = "mg" | "mcg" | "IU";
type VolumeUnit = "mL";   // only converts via reconstitution
type CountUnit = "pcs";   // counts; only converts to itself
type DoseUnit = MassUnit | VolumeUnit | CountUnit;

interface InventoryLot {
  id: string; // UUID
  vialCount: number;        // containers/vials/bottles currently on hand
  contentAmount: number;    // medication amount in one container
  contentUnit: DoseUnit;    // e.g., mg, mL, pcs
  orderDate?: string;       // "YYYY-MM-DD"
  deliveryDate?: string;    // "YYYY-MM-DD"
  vendor?: string;
  pricePerContainer?: number; // USD per vial/container (v7)
  coaUrls?: string[];       // http(s) certificate-of-analysis links
  notes?: string;
}

interface Medication {
    id: string; // UUID
    name: string; // e.g., "Semaglutide", "BPC-157"
  type: "peptide" | "injection" | "pill" | "liquid" | "supplement" | "other";
  unit: DoseUnit; // primary unit for doses, inventory and thresholds

  // Reconstitution Info (peptides only; linked to active schedules for dose volumes)
    reconstitution?: {
      vialQuantity: number;      // explicit vial mass, e.g., 5 (mg)
      vialQuantityUnit: MassUnit;
      bacWaterAmountMl: number;  // e.g., 2 (ml) → concentration 2.5 mg/mL
    };

  // Inventory Tracking — totals derived from the lots
    inventory: {
      lots: InventoryLot[];
      lowStockThreshold?: number; // in `unit`
    };

    halfLifeHours?: number; // For concentration model (e.g., 168 hours for 7 days)
    notes?: string;
    createdAt: string; // ISO Date
    updatedAt: string; // ISO Date
}
```

### 3.2 Schedule & Dosing Log

```ts
interface Schedule {
    id: string;
    medicationId: string;
    doseAmount: number;
  unit: DoseUnit;
    frequencyType: 'daily' | 'weekly' | 'custom_interval';
    intervalDays?: number; // Used if frequencyType === 'custom_interval'
    timeOfDay: string; // "HH:MM"
    startDate: string; // ISO Date
    active: boolean;
}

interface DoseLog {
    id: string;
    medicationId: string;
    scheduleId?: string; // Optional reference if logged from a schedule
    doseAmount: number;
  unit: DoseUnit;
    timestamp: string; // ISO Date String
  // v4: optional injection site (e.g. "Abdomen") — free text; the form
  // offers presets plus an "other" free-text field.
  injectionSite?: string;
    notes?: string;
}
```

### 3.3 Body Measurements

> **v5:** measurement types gain an optional `valueKind`
> (`"numeric" | "blood_pressure"`; absent ≡ numeric). The two built-in
> trackers (Weight, Blood Pressure — fixed ids, not deletable, kind locked)
> are seeded idempotently by `lib/measurements/service.ts`; a BP reading is
> stored as the string `"120/80"`. Deleting a custom tracker cascades to its
> logs.

```ts
type MeasurementValueKind = "numeric" | "blood_pressure";

interface MeasurementType {
    id: string;
    name: string; // e.g., "Weight", "Blood Pressure", "Waist Circumference"
  unit: string; // e.g., "kg", "lbs", "mmHg", "cm", "%", "mmol/L", "bpm"
    isCustom: boolean;
  valueKind?: MeasurementValueKind; // v5 — drives input shape & trend series
}

interface MeasurementLog {
    id: string;
    measurementTypeId: string;
    value: number | string; // Numeric for standard measurements, string allowed for BP ("120/80")
    timestamp: string; // ISO Date
    notes?: string;
}
```

---

## 4. Key Features & Implementation Logic

### 4.1 Unit Conversions

Standardize calculation units internally to base units (`mg` or standard SI units) and convert for display:

- `1 mg = 1000 mcg`
- `IU` conversions require user-specified weight per IU when applicable, or a default 1:1 fallback warning flag.

### 4.2 Concentration Calculations (Pharmacokinetics)

- **Model**: First-order elimination single-compartment model.
- **Formula**:
  $$\text{Concentration}(t) = \sum_{i} C_i \cdot e^{-\lambda (t - t_i)}$$
  Where $\lambda = \frac{\ln(2)}{t_{1/2}}$ (half-life in hours) and $C_i$ is the dose administered at time $t_i$.
- **Calculation Data Sources**: Combine **past logged doses** (`DoseLog`) with **future projected doses** (`Schedule`)
  for continuous concentration modeling.
- **Chart Ranges**: Options for `24h`, `1W`, `2W`, `1M`, `2M`, `3M`, `6M`.

### 4.3 Reconstitution Info

- Display calculate dosage volume in syringe ticks or `mL`:
  $$\text{Dose Volume (mL)} = \frac{\text{Desired Dose}}{\text{Vial Quantity}} \times \text{BAC Water (mL)}$$
- Standard U-100 syringe visualizer context where $1\text{ mL} = 100\text{ units}$.

---

## 5. UI/UX Design System

- **Style**: Modern, compact, dense data presentation. Modern dark/light mode toggle.
- **Density**: Minimal padding, clear iconography, quick inline logging buttons.
- **Dashboard Modules**:
    1. **Quick Log**: One-tap completion of scheduled doses for today.
    2. **Active Inventory**: Compact status cards with low-stock badges.
    3. **Pharmacokinetic Chart**: Toggleable overlay curves for multi-medication visual comparison.
    4. **Metrics Widget**: Quick log form and recent entries graph.

---

## 6. Development Workflow Guidelines

1. **Components First**: Maintain strict modularity using standard `shadcn/ui` primitives.
2. **Offline Testing**: Ensure service workers properly cache all static bundle assets (`next export`).
3. **Data Protection**: Prompt confirmation on bulk operations or schema upgrades; auto-backup generation before
   migrations.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read
the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next`
package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at
`node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted
change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

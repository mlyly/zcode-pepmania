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

> **v2 (current):** types are granular (`peptide`/`injection`/`pill`/`liquid`/`supplement`/`other`),
> dose units include `mL`, and inventory tracks an optional per-container size. The v1 → v2
> migration (see `lib/db/migrations.ts`) remaps the legacy generic `"medication"` type to `"pill"`
> and preserves an automatic pre-migration backup.

```ts
type MassUnit = "mg" | "mcg" | "IU";
type DoseUnit = MassUnit | "mL"; // volume — only converts via reconstitution

interface Medication {
    id: string; // UUID
    name: string; // e.g., "Semaglutide", "BPC-157"
  type: "peptide" | "injection" | "pill" | "liquid" | "supplement" | "other";
  unit: DoseUnit; // primary unit for doses, inventory and thresholds

  // Reconstitution Info (peptides only; linked to active schedules for dose volumes)
    reconstitution?: {
        vialQuantity: number;      // e.g., 5 (mg)
      vialQuantityUnit: MassUnit;
      bacWaterAmountMl: number;  // e.g., 2 (ml) → concentration 2.5 mg/mL
    };

    // Inventory Tracking
    inventory: {
        currentQuantity: number; // In selected unit (e.g., mg)
      vialCount: number;       // vials / bottles / packs on hand
      containerSize?: number;  // amount per container (unit size), in `unit`
        lowStockThreshold?: number;
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
    unit: 'mg' | 'mcg' | 'IU';
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
    unit: 'mg' | 'mcg' | 'IU';
    timestamp: string; // ISO Date String
    notes?: string;
}
```

### 3.3 Body Measurements

```ts
interface MeasurementType {
    id: string;
    name: string; // e.g., "Weight", "Blood Pressure", "Waist Circumference"
    unit: string; // e.g., "kg", "lbs", "mmHg", "cm"
    isCustom: boolean;
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
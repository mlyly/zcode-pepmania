/**
 * Public types for the pharmacokinetic (PK) concentration engine.
 *
 * The model is a first-order, single-compartment elimination model with
 * instantaneous (bolus) dosing — the formula specified in AGENTS.md §4.2:
 *
 *   C(t) = Σ C_i · e^(-λ · (t - t_i))
 *
 * where λ = ln(2) / t½. A dose's contribution `C_i` is its mass in mg scaled
 * by bioavailability, and optionally divided by a volume of distribution:
 *
 *   C_i = doseMg × bioavailability / volumeOfDistributionL
 *
 * Without a volume of distribution the result is a **dose-equivalent**
 * concentration (`"mg-eq"`), which is still useful for relative decay curves
 * and multi-medication overlays. With one, the result is a true `"mg/L"`.
 */
import type {DoseLog, Medication, Schedule} from "@/lib/db/types";

/** Unit of the computed concentration. */
export type PkConcentrationUnit = "mg/L" | "mg-eq";

/**
 * Per-medication PK configuration. Every field is optional; the engine falls
 * back to `Medication.halfLifeHours` and then `PkBuildOptions.defaultProfile`.
 *
 * `eliminationRatePerHour` takes precedence over `halfLifeHours` when both are
 * supplied, so callers can provide a directly fitted rate constant.
 */
export interface PkProfile {
    /** Elimination half-life in hours (e.g. 168 for a 7-day peptide). */
    halfLifeHours?: number;
    /** First-order elimination rate λ in h⁻¹. */
    eliminationRatePerHour?: number;
    /**
     * Fraction of the dose that reaches systemic circulation, 0 < F ≤ 1.
     * Defaults to 1 (complete bioavailability).
     */
    bioavailability?: number;
    /**
     * Apparent volume of distribution in litres. When set, concentrations are
     * expressed in mg/L; otherwise the engine reports mg-equivalent values.
     */
    volumeOfDistributionL?: number;
}

/** A validated, immutable profile ready for the math kernels. */
export interface ResolvedPkProfile {
    halfLifeHours: number;
    eliminationRatePerHour: number;
    bioavailability: number;
    volumeOfDistributionL?: number;
    /** Multiplier turning a dose in mg into concentration units (F / V). */
    concentrationPerMg: number;
    concentrationUnit: PkConcentrationUnit;
}

export type PkProfileFailureCode =
    | "missing-elimination-data"
    | "invalid-elimination-rate"
    | "invalid-half-life"
    | "invalid-bioavailability"
    | "invalid-volume";

export type PkProfileResolution =
    | { ok: true; profile: ResolvedPkProfile }
    | { ok: false; code: PkProfileFailureCode; message: string };

export type PkDoseKind = "logged" | "scheduled";

/**
 * One dose event fed to the math kernels. Times are epoch milliseconds so the
 * hot loops never allocate `Date` objects.
 */
export interface PkDoseEvent {
    /** Stable source id (dose-log id or occurrence key). */
    id: string;
    medicationId: string;
    kind: PkDoseKind;
    /** Epoch milliseconds the dose enters the body. */
    timestamp: number;
    /** Mass-equivalent dose in mg (IU uses the app's documented 1:1 fallback). */
    amountMg: number;
    scheduleId?: string;
    /** True for a scheduled occurrence that is still in the future. */
    projected?: boolean;
}

export type PkWarningCode =
    | PkProfileFailureCode
    | "invalid-timestamp"
    | "invalid-dose"
    | "unconvertible-dose"
    | "iu-fallback";

/** Structured, non-fatal issue encountered while building a model. */
export interface PkWarning {
    code: PkWarningCode;
    message: string;
    medicationId?: string;
    medicationName?: string;
    doseLogId?: string;
    scheduleId?: string;
}

export interface PkDoseCounts {
    logged: number;
    scheduled: number;
    /** Subset of `scheduled` that lies after `now`. */
    projected: number;
}

/** One point on a concentration curve. */
export interface PkSeriesPoint {
    /** Epoch milliseconds. */
    timestamp: number;
    /** Concentration in `PkMedicationSeries.concentrationUnit`. */
    concentration: number;
}

export interface PkPeak {
    /** Epoch milliseconds of the peak. */
    timestamp: number;
    concentration: number;
}

export interface PkMedicationSeries {
    medicationId: string;
    medicationName: string;
    concentrationUnit: PkConcentrationUnit;
    profile: ResolvedPkProfile;
    points: PkSeriesPoint[];
    /** Highest post-dose concentration within the requested window. */
    peak: PkPeak;
    doseCounts: PkDoseCounts;
}

export interface PkBuildInput {
    medications: readonly Medication[];
    schedules: readonly Schedule[];
    doseLogs: readonly DoseLog[];
}

/**
 * Options for a full model build.
 *
 * `start`/`end` define the chart window. Doses older than the window are still
 * included until their remaining contribution falls below `pruneThreshold`
 * (a wash-out lookback), so a curve starts at the correct residual level.
 */
export interface PkBuildOptions {
    start: Date | number | string;
    end: Date | number | string;
    /** Reference instant used to mark scheduled doses as projected. Defaults to now. */
    now?: Date | number | string;
    /** Preferred spacing between samples, in minutes. Default 60. */
    stepMinutes?: number;
    /** Hard cap on the number of sample points. Default 2000. */
    maxPoints?: number;
    /** Per-medication overrides, keyed by `Medication.id`. */
    profiles?: Readonly<Record<string, PkProfile | undefined>>;
    /** Fallback profile applied beneath medication fields and overrides. */
    defaultProfile?: PkProfile;
    /** Include unlogged scheduled occurrences before `now`. Default true. */
    includePastScheduledDoses?: boolean;
    /** Include scheduled occurrences after `now`. Default true. */
    includeFutureScheduledDoses?: boolean;
    /**
     * Add exact dose instants to the sample grid so post-dose peaks are always
     * visible on charts (when the point budget allows). Default true.
     */
    includeDoseTimestamps?: boolean;
    /**
     * Relative contribution below which pre-window doses are discarded.
     * Default 1e-6 (≈ 20 half-lives). Must be in (0, 1).
     */
    pruneThreshold?: number;
    /**
     * Safety cap for synthesizing missed scheduled doses into the past, in
     * days. Actual logged doses are still considered for the full wash-out
     * lookback. Default 3650 (10 years).
     */
    maxScheduledLookbackDays?: number;
}

export interface PkResult {
    /** Window start, epoch ms. */
    start: number;
    /** Window end, epoch ms. */
    end: number;
    /** Effective (uniform-grid) sample spacing in minutes. */
    stepMinutes: number;
    series: PkMedicationSeries[];
    /**
     * All dose events considered by the model, sorted by time — including
     * lookback events before `start` and projected doses (`projected: true`)
     * after `now`. Dashboards use these to mark dose instants on the curve.
     */
    events: PkDoseEvent[];
    warnings: PkWarning[];
}

/**
 * Pure PK math kernels: profile validation, single-point evaluation and a
 * streaming curve builder.
 *
 * The curve builder is O(D + S) after the dose list is sorted (D = dose events,
 * S = sample points). Instead of re-summing every historical dose at every
 * sample, it decays the running total forward and folds in doses as their
 * timestamps are crossed. That keeps large logs cheap on the client.
 */
import type {PkDoseEvent, PkPeak, PkProfile, PkProfileResolution, ResolvedPkProfile,} from "./types";

export const MS_PER_HOUR = 3_600_000;

/**
 * Hard safety cap on the wash-out lookback (~100 years). Keeps pathological
 * half-lives from producing nonsensical timestamps while remaining far larger
 * than any clinically relevant window.
 */
export const MAX_LOOKBACK_HOURS = 24 * 366 * 100;

/** Converts a half-life (hours) to a first-order elimination rate (h⁻¹). */
export function halfLifeToRate(halfLifeHours: number): number {
    return Math.LN2 / halfLifeHours;
}

/** Converts an elimination rate (h⁻¹) to a half-life (hours). */
export function rateToHalfLife(eliminationRatePerHour: number): number {
    return Math.LN2 / eliminationRatePerHour;
}

/**
 * Validates a user-supplied profile and resolves it into the numbers used by
 * the hot loop. Returns a structured failure instead of throwing so callers
 * can skip one medication without breaking the whole chart.
 */
export function resolvePkProfile(profile: PkProfile): PkProfileResolution {
    let rate: number;

    if (profile.eliminationRatePerHour !== undefined) {
        if (
            !Number.isFinite(profile.eliminationRatePerHour) ||
            profile.eliminationRatePerHour <= 0
        ) {
            return {
                ok: false,
                code: "invalid-elimination-rate",
                message: "Elimination rate must be a positive, finite number (h⁻¹).",
            };
        }
        rate = profile.eliminationRatePerHour;
    } else if (profile.halfLifeHours !== undefined) {
        if (!Number.isFinite(profile.halfLifeHours) || profile.halfLifeHours <= 0) {
            return {
                ok: false,
                code: "invalid-half-life",
                message: "Half-life must be a positive, finite number of hours.",
            };
        }
        rate = halfLifeToRate(profile.halfLifeHours);
    } else {
        return {
            ok: false,
            code: "missing-elimination-data",
            message:
                "No half-life or elimination rate configured, so a concentration curve cannot be computed.",
        };
    }

    const bioavailability = profile.bioavailability ?? 1;
    if (
        !Number.isFinite(bioavailability) ||
        bioavailability <= 0 ||
        bioavailability > 1
    ) {
        return {
            ok: false,
            code: "invalid-bioavailability",
            message: "Bioavailability must be greater than 0 and at most 1.",
        };
    }

    if (
        profile.volumeOfDistributionL !== undefined &&
        (!Number.isFinite(profile.volumeOfDistributionL) ||
            profile.volumeOfDistributionL <= 0)
    ) {
        return {
            ok: false,
            code: "invalid-volume",
            message: "Volume of distribution must be a positive, finite number of litres.",
        };
    }

    const volume = profile.volumeOfDistributionL;
    return {
        ok: true,
        profile: {
            halfLifeHours: rateToHalfLife(rate),
            eliminationRatePerHour: rate,
            bioavailability,
            volumeOfDistributionL: volume,
            concentrationPerMg: bioavailability / (volume ?? 1),
            concentrationUnit: volume === undefined ? "mg-eq" : "mg/L",
        },
    };
}

/**
 * Hours of wash-out needed for a dose's remaining fraction to fall below
 * `threshold` (e.g. 1e-6 ≈ 20 half-lives), capped for numerical safety.
 */
export function lookbackHours(
    profile: ResolvedPkProfile,
    threshold = 1e-6
): number {
    const hours = Math.log(1 / threshold) / profile.eliminationRatePerHour;
    return Math.min(Number.isFinite(hours) ? hours : MAX_LOOKBACK_HOURS, MAX_LOOKBACK_HOURS);
}

/** Remaining fraction of a dose after `elapsedHours`. */
export function remainingFraction(
    profile: ResolvedPkProfile,
    elapsedHours: number
): number {
    return Math.exp(-profile.eliminationRatePerHour * Math.max(0, elapsedHours));
}

/** A single dose's contribution at an instant, in concentration units. */
export function doseContribution(
    profile: ResolvedPkProfile,
    dose: PkDoseEvent,
    atMs: number
): number {
    const elapsedHours = (atMs - dose.timestamp) / MS_PER_HOUR;
    if (elapsedHours < 0) return 0;
    return (
        dose.amountMg *
        profile.concentrationPerMg *
        Math.exp(-profile.eliminationRatePerHour * elapsedHours)
    );
}

/**
 * Concentration at one instant: Σ dose × F/V × e^(-λ·age) over doses taken at
 * or before `atMs` (post-dose semantics for a dose exactly at that instant).
 */
export function concentrationAt(
    doses: readonly PkDoseEvent[],
    atMs: number,
    profile: ResolvedPkProfile
): number {
    const sorted = ensureSorted(doses);
    let total = 0;
    for (const dose of sorted) {
        if (dose.timestamp > atMs) break;
        total += doseContribution(profile, dose, atMs);
    }
    return total;
}

/**
 * Builds a concentration curve for arbitrary, ascending sample times.
 *
 * Doses before the first sample establish the starting residual level; each
 * subsequent sample decays the running total and adds any doses crossed since
 * the previous sample. Returns one value per sample time.
 */
export function concentrationSeries(
    doses: readonly PkDoseEvent[],
    sampleTimes: readonly number[],
    profile: ResolvedPkProfile
): number[] {
    if (sampleTimes.length === 0) return [];

    const sorted = ensureSorted(doses);
    const out = new Array<number>(sampleTimes.length);
    const rate = profile.eliminationRatePerHour;

    let index = 0;
    let level = 0;
    let previous = sampleTimes[0];

    if (!Number.isFinite(previous)) {
        throw new RangeError("Sample times must be finite epoch milliseconds.");
    }

    while (index < sorted.length && sorted[index].timestamp <= previous) {
        level += doseContribution(profile, sorted[index], previous);
        index += 1;
    }
    out[0] = level;

    for (let i = 1; i < sampleTimes.length; i += 1) {
        const time = sampleTimes[i];
        if (!Number.isFinite(time)) {
            throw new RangeError("Sample times must be finite epoch milliseconds.");
        }
        if (time < previous) {
            throw new RangeError("Sample times must be sorted ascending.");
        }

        if (time > previous) {
            level *= Math.exp((-rate * (time - previous)) / MS_PER_HOUR);
        }

        while (index < sorted.length && sorted[index].timestamp <= time) {
            level += doseContribution(profile, sorted[index], time);
            index += 1;
        }

        out[i] = level;
        previous = time;
    }

    return out;
}

/**
 * Exact highest post-dose concentration in [from, to], evaluated at each dose
 * instant. With instantaneous dosing the curve's local maxima can only occur
 * at dose times (or at `from`), so this is O(D) and independent of chart
 * sampling.
 */
export function peakConcentration(
    doses: readonly PkDoseEvent[],
    profile: ResolvedPkProfile,
    from: number,
    to: number
): PkPeak {
    if (to < from) {
        throw new RangeError("Peak window end must not precede its start.");
    }

    const sorted = ensureSorted(doses);
    let index = 0;
    let level = 0;

    while (index < sorted.length && sorted[index].timestamp <= from) {
        level += doseContribution(profile, sorted[index], from);
        index += 1;
    }

    let peak: PkPeak = {timestamp: from, concentration: level};
    let previous = from;

    while (index < sorted.length && sorted[index].timestamp <= to) {
        const dose = sorted[index];
        if (dose.timestamp > previous) {
            level *=
                Math.exp(
                    (-profile.eliminationRatePerHour *
                        (dose.timestamp - previous)) /
                    MS_PER_HOUR
                );
            previous = dose.timestamp;
        }
        level += dose.amountMg * profile.concentrationPerMg;
        if (level > peak.concentration) {
            peak = {timestamp: dose.timestamp, concentration: level};
        }
        index += 1;
    }

    return peak;
}

/**
 * Sorts a copy only when the input is out of order, so the engine's already
 * sorted arrays are passed straight through without an allocation.
 */
export function ensureSorted(doses: readonly PkDoseEvent[]): readonly PkDoseEvent[] {
    for (let i = 1; i < doses.length; i += 1) {
        if (doses[i - 1].timestamp > doses[i].timestamp) {
            return [...doses].sort(
                (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
            );
        }
    }
    return doses;
}

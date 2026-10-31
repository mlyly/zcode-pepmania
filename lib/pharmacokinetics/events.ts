/**
 * Turns the persisted domain data (medications, schedules and dose logs) into
 * a single, deduplicated, time-sorted list of dose events for the PK model.
 *
 * Historical logs are facts. Scheduled occurrences stand in for doses that
 * have no matching log — future projections and (optionally) missed doses in
 * the past. An occurrence that a log already completed is skipped so the same
 * dose is never counted twice.
 */
import type {DoseLog, DoseUnit, Medication, Schedule} from "@/lib/db/types";
import {reconstitutionConcentration} from "@/lib/medications/derived";
import {addDays, dateOnlyIso, startOfLocalDay,} from "@/lib/scheduling/dates";
import {expandSchedules, MAX_EXPANSION_DAYS, type Occurrence,} from "@/lib/scheduling/occurrences";
import {massToMg} from "@/lib/units";

import {lookbackHours, MS_PER_HOUR} from "./model";
import type {PkDoseCounts, PkDoseEvent, PkWarning, PkWarningCode, ResolvedPkProfile,} from "./types";

export interface PkDoseCollectionOptions {
    /** Chart window start, epoch ms. */
    start: number;
    /** Chart window end, epoch ms. */
    end: number;
    /** Reference instant for "projected" labels, epoch ms. */
    now: number;
    /** Resolved profiles keyed by medication id; medications without one are skipped. */
    profiles: ReadonlyMap<string, ResolvedPkProfile>;
    includePastScheduledDoses: boolean;
    includeFutureScheduledDoses: boolean;
    /** Relative contribution below which pre-window doses are discarded. */
    pruneThreshold: number;
    /** Cap on synthesizing unlogged past occurrences, in days. */
    maxScheduledLookbackDays: number;
}

export interface PkDoseCollection {
    events: PkDoseEvent[];
    warnings: PkWarning[];
    counts: Map<string, PkDoseCounts>;
}

interface DoseMass {
    amountMg: number;
    iuFallback: boolean;
}

/**
 * Converts a dose in the app's stored units to mg. Mass units convert
 * directly (`IU` uses the documented 1:1 fallback); `mL` needs a
 * reconstitution concentration and returns null when none is available.
 */
export function doseAmountToMg(
    amount: number,
    unit: DoseUnit,
    medication: Pick<Medication, "reconstitution" | "unit">
): DoseMass | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;

    if (unit === "mL") {
        const concentration = reconstitutionConcentration(medication);
        if (!concentration) return null;
        return {
            amountMg: amount * concentration.mgPerMl,
            iuFallback: concentration.iuFallback,
        };
    }
    // Counts (pcs) have no mass, so they can't feed the concentration model.
    if (unit === "pcs") return null;

    const converted = massToMg(amount, unit);
    return {amountMg: converted.value, iuFallback: converted.iuFallback};
}

/**
 * Collects every dose event relevant to the window. Dose-log timestamps and
 * scheduled occurrence instants are the only sources; no network or DB access
 * happens here.
 */
export function collectDoseEvents(
    medications: readonly Medication[],
    schedules: readonly Schedule[],
    doseLogs: readonly DoseLog[],
    options: PkDoseCollectionOptions
): PkDoseCollection {
    const {
        start,
        end,
        now,
        profiles,
        includePastScheduledDoses,
        includeFutureScheduledDoses,
        pruneThreshold,
        maxScheduledLookbackDays,
    } = options;

    const events: PkDoseEvent[] = [];
    const warnings: PkWarning[] = [];
    const warningKeys = new Set<string>();
    const counts = new Map<string, PkDoseCounts>();
    for (const medicationId of profiles.keys()) {
        counts.set(medicationId, {logged: 0, scheduled: 0, projected: 0});
    }

    const medicationById = new Map(medications.map((medication) => [medication.id, medication]));

    // Pre-compute each medication's wash-out cutoff once. Actual logs get the
    // full lookback; synthesized occurrences are additionally capped so a
    // decades-old daily schedule never generates an unbounded event list.
    const logCutoffByMedication = new Map<string, number>();
    const scheduleCutoffByMedication = new Map<string, number>();
    let widestScheduleLookbackMs = 0;
    for (const [medicationId, profile] of profiles) {
        const fullLookbackHours = lookbackHours(profile, pruneThreshold);
        const fullLookbackMs = fullLookbackHours * MS_PER_HOUR;
        const scheduleLookbackMs =
            Math.min(fullLookbackHours, maxScheduledLookbackDays * 24) * MS_PER_HOUR;
        logCutoffByMedication.set(medicationId, start - fullLookbackMs);
        scheduleCutoffByMedication.set(medicationId, start - scheduleLookbackMs);
        widestScheduleLookbackMs = Math.max(
            widestScheduleLookbackMs,
            scheduleLookbackMs
        );
    }

    const warn = (
        code: PkWarningCode,
        message: string,
        extra: Omit<PkWarning, "code" | "message"> = {}
    ) => {
        const key = [
            code,
            extra.medicationId ?? "",
            message,
        ].join("|");
        if (warningKeys.has(key)) return;
        warningKeys.add(key);
        warnings.push({code, message, ...extra});
    };

    const addEvent = (
        event: PkDoseEvent,
        medication: Medication,
        mass: DoseMass,
        source: { doseLogId?: string; scheduleId?: string }
    ) => {
        events.push(event);
        const bucket = counts.get(event.medicationId);
        if (bucket) {
            if (event.kind === "logged") bucket.logged += 1;
            else {
                bucket.scheduled += 1;
                if (event.projected) bucket.projected += 1;
            }
        }
        if (mass.iuFallback) {
            warn(
                "iu-fallback",
                `${medication.name}: IU doses are treated as 1 IU = 1 mg for concentration math.`,
                {medicationId: medication.id, medicationName: medication.name, ...source}
            );
        }
    };

    // ------------------------------------------------------------- dose logs
    for (const log of doseLogs) {
        if (!profiles.has(log.medicationId)) continue;
        const medication = medicationById.get(log.medicationId);
        if (!medication) continue;

        const timestamp = Date.parse(log.timestamp);
        if (!Number.isFinite(timestamp)) {
            warn("invalid-timestamp", `${medication.name}: a dose log has an invalid timestamp.`, {
                medicationId: medication.id,
                medicationName: medication.name,
                doseLogId: log.id,
            });
            continue;
        }
        if (timestamp > end) continue;

        const cutoff = logCutoffByMedication.get(log.medicationId);
        if (cutoff === undefined || timestamp < cutoff) continue;

        if (!Number.isFinite(log.doseAmount) || log.doseAmount <= 0) {
            warn("invalid-dose", `${medication.name}: a dose log has a non-positive amount.`, {
                medicationId: medication.id,
                medicationName: medication.name,
                doseLogId: log.id,
            });
            continue;
        }

        const mass = doseAmountToMg(log.doseAmount, log.unit, medication);
        if (!mass) {
            warn(
                "unconvertible-dose",
                `${medication.name}: a ${log.unit} dose log cannot be converted to mg without a reconstitution concentration.`,
                {
                    medicationId: medication.id,
                    medicationName: medication.name,
                    doseLogId: log.id,
                }
            );
            continue;
        }

        addEvent(
            {
                id: `log:${log.id}`,
                medicationId: medication.id,
                kind: "logged",
                timestamp,
                amountMg: mass.amountMg,
                scheduleId: log.scheduleId,
            },
            medication,
            mass,
            {doseLogId: log.id}
        );
    }

    // ------------------------------------------------------------- schedules
    const activeSchedules = schedules.filter((schedule) => schedule.active);
    if (
        activeSchedules.length > 0 &&
        profiles.size > 0 &&
        (includePastScheduledDoses || includeFutureScheduledDoses)
    ) {
        if (widestScheduleLookbackMs > 0 && start - widestScheduleLookbackMs <= end) {
            const occurrences = expandSchedulesChunked(
                activeSchedules,
                start - widestScheduleLookbackMs,
                end
            );

            // Fast occurrence → log matching, mirroring `matchingDoseLog`:
            // exact `scheduledFor`, then the legacy same-schedule same-day rule.
            const completedExact = new Set<string>();
            const completedLegacyDay = new Set<string>();
            for (const log of doseLogs) {
                if (!log.scheduleId) continue;
                if (log.scheduledFor) {
                    completedExact.add(`${log.scheduleId}|${log.scheduledFor}`);
                    continue;
                }
                const timestamp = Date.parse(log.timestamp);
                if (!Number.isFinite(timestamp)) continue;
                completedLegacyDay.add(
                    `${log.scheduleId}|${dateOnlyIso(new Date(timestamp))}`
                );
            }

            for (const occurrence of occurrences) {
                if (!profiles.has(occurrence.medicationId)) continue;
                const medication = medicationById.get(occurrence.medicationId);
                if (!medication) continue;

                const timestamp = occurrence.scheduledAt.getTime();
                if (timestamp > end) continue;

                const cutoff = scheduleCutoffByMedication.get(occurrence.medicationId);
                if (cutoff === undefined || timestamp < cutoff) continue;

                const projected = timestamp > now;
                if (projected ? !includeFutureScheduledDoses : !includePastScheduledDoses) {
                    continue;
                }

                if (
                    completedExact.has(
                        `${occurrence.scheduleId}|${occurrence.scheduledFor}`
                    ) ||
                    completedLegacyDay.has(
                        `${occurrence.scheduleId}|${occurrence.dateIso}`
                    )
                ) {
                    continue;
                }

                if (
                    !Number.isFinite(occurrence.doseAmount) ||
                    occurrence.doseAmount <= 0
                ) {
                    warn(
                        "invalid-dose",
                        `${medication.name}: a scheduled dose has a non-positive amount.`,
                        {
                            medicationId: medication.id,
                            medicationName: medication.name,
                            scheduleId: occurrence.scheduleId,
                        }
                    );
                    continue;
                }

                const mass = doseAmountToMg(
                    occurrence.doseAmount,
                    occurrence.unit,
                    medication
                );
                if (!mass) {
                    warn(
                        "unconvertible-dose",
                        `${medication.name}: a ${occurrence.unit} scheduled dose cannot be converted to mg without a reconstitution concentration.`,
                        {
                            medicationId: medication.id,
                            medicationName: medication.name,
                            scheduleId: occurrence.scheduleId,
                        }
                    );
                    continue;
                }

                addEvent(
                    {
                        id: `sched:${occurrence.key}`,
                        medicationId: medication.id,
                        kind: "scheduled",
                        timestamp,
                        amountMg: mass.amountMg,
                        scheduleId: occurrence.scheduleId,
                        projected,
                    },
                    medication,
                    mass,
                    {scheduleId: occurrence.scheduleId}
                );
            }
        }
    }

    events.sort(
        (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
    );

    return {events, warnings, counts};
}

/**
 * Expands occurrences across arbitrarily long ranges by slicing them into
 * windows no larger than the scheduling engine's safety bound.
 */
export function expandSchedulesChunked(
    schedules: readonly Schedule[],
    fromMs: number,
    toMs: number
): Occurrence[] {
    const occurrences: Occurrence[] = [];
    let cursor = startOfLocalDay(new Date(fromMs));
    const end = startOfLocalDay(new Date(toMs));
    const list = schedules.slice();

    while (cursor.getTime() <= end.getTime()) {
        const chunkEnd = addDays(cursor, MAX_EXPANSION_DAYS - 1);
        const boundedEnd = chunkEnd.getTime() > end.getTime() ? end : chunkEnd;
        const chunk = expandSchedules(list, cursor, boundedEnd);
        for (const occurrence of chunk) occurrences.push(occurrence);
        cursor = addDays(boundedEnd, 1);
    }

    return occurrences;
}

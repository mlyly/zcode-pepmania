/**
 * Small derived helpers shared by the scheduling and dose log modules.
 * Pure functions (no DB access) so the UI and smoke tests can reason about
 * them deterministically.
 */
import type {Medication, Schedule} from "@/lib/db/types";

/**
 * Dose amount to prefill a "log a dose" dialog for a medication: the dose of
 * its first active schedule, when that schedule uses the medication's own
 * unit (so the number is directly reusable); otherwise 1.
 */
export function prefilledDoseAmount(
    medication: Medication | null | undefined,
    schedules: readonly Schedule[]
): number {
    if (!medication) return 1;
    const schedule = schedules.find((s) => s.medicationId === medication.id && s.active);
    return schedule && schedule.unit === medication.unit ? schedule.doseAmount : 1;
}

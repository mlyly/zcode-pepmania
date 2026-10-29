/**
 * Medication domain vocabularies shared by the UI, forms and service layer.
 * (The migration layer keeps its own frozen copies — see `lib/db/migrations.ts`.)
 */
import {Droplets, FlaskConical, Leaf, type LucideIcon, Package, Pill, Syringe,} from "lucide-react";

import type {MedicationType} from "@/lib/db/types";

export const MEDICATION_TYPES = [
    "peptide",
    "injection",
    "pill",
    "liquid",
    "supplement",
    "other",
] as const;

export const DOSE_UNITS = ["mg", "mcg", "IU", "mL"] as const;
export const MASS_UNITS = ["mg", "mcg", "IU"] as const;

export interface MedicationTypeMeta {
    value: MedicationType;
    label: string;
    /** One-line hint shown in the type picker. */
    description: string;
    icon: LucideIcon;
    /** Subtle tinted badge classes (light + dark). */
    badgeClass: string;
    /** What a single container of this type is usually called. */
    containerNoun: string;
}

export const MEDICATION_TYPE_META: Record<MedicationType, MedicationTypeMeta> = {
    peptide: {
        value: "peptide",
        label: "Peptide",
        description: "Lyophilized powder vial, reconstituted with BAC water.",
        icon: FlaskConical,
        badgeClass:
            "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
        containerNoun: "vial",
    },
    injection: {
        value: "injection",
        label: "Injection",
        description: "Injectable medication or pre-mixed solution.",
        icon: Syringe,
        badgeClass:
            "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
        containerNoun: "vial",
    },
    pill: {
        value: "pill",
        label: "Pill",
        description: "Oral tablets or capsules.",
        icon: Pill,
        badgeClass:
            "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
        containerNoun: "bottle",
    },
    liquid: {
        value: "liquid",
        label: "Liquid",
        description: "Oral solution or tincture dosed by volume.",
        icon: Droplets,
        badgeClass:
            "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
        containerNoun: "bottle",
    },
    supplement: {
        value: "supplement",
        label: "Supplement",
        description: "Vitamins, minerals, amino acids and the like.",
        icon: Leaf,
        badgeClass:
            "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
        containerNoun: "bottle",
    },
    other: {
        value: "other",
        label: "Other",
        description: "Anything that doesn't fit the categories above.",
        icon: Package,
        badgeClass: "border-border bg-muted text-muted-foreground",
        containerNoun: "container",
    },
};

export function medicationTypeMeta(type: MedicationType): MedicationTypeMeta {
    return MEDICATION_TYPE_META[type] ?? MEDICATION_TYPE_META.other;
}

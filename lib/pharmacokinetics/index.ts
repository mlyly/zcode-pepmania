/**
 * Pharmacokinetic concentration engine (AGENTS.md §4.2).
 *
 * ```ts
 * const result = buildPkConcentrationSeries(
 *     {medications, schedules, doseLogs},
 *     {start: chartStart, end: chartEnd, profiles: {[medId]: {volumeOfDistributionL: 8}}}
 * );
 *
 * result.series.forEach((series) => render(series.points));
 * ```
 *
 * Pure math lives in `model.ts`, persisted-data → dose-event collection lives
 * in `events.ts`, and `engine.ts` composes them. All modules are client-safe
 * (no DB, network, React or browser globals).
 */
export * from "./types";
export * from "./model";
export * from "./events";
export * from "./engine";

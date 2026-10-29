import {execSync} from "node:child_process";

/**
 * Build-time application info, captured from git while Next.js prerenders the
 * static export. Server-only: importing this from a client component would
 * pull `node:child_process` into the browser bundle.
 */

function runGit(format: string): string {
    return execSync(`git log -1 --format=${format}`, {
        encoding: "utf8",
        // `git` may be missing (e.g. source tarball builds); treat as unknown.
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

const commitDateIso = tryGetOrNull(() => runGit("%cI"));
const commitHash = tryGetOrNull(() => runGit("%h"));

function tryGetOrNull<T>(fn: () => T): T | null {
    try {
        const value = fn();
        return value === "" ? null : value;
    } catch {
        return null;
    }
}

// `%cI` yields strict ISO 8601 with an offset, e.g. `2026-10-29T12:11:19+02:00`.
// The date/time portion is already the committer's civil (wall-clock) time, so
// both parts are taken straight from the string to keep them consistent.
const commitDateMatch = commitDateIso?.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/,
);

/** Latest app modification date as ISO `YYYY-MM-DD`, or null when git is unavailable. */
export const LAST_MODIFIED: string | null = commitDateMatch?.[1] ?? null;

/** Latest app modification time as `HH:mm`, or null when git is unavailable. */
export const LAST_MODIFIED_TIME: string | null = commitDateMatch?.[2] ?? null;

/** Short commit hash, or null when git is unavailable. */
export const LAST_COMMIT_HASH: string | null = commitHash;

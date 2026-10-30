// ---------------------------------------------------------------------------
// Storage-error vocabulary (AGENTS.md §2 — quota handled gracefully)
// ---------------------------------------------------------------------------

/** True when the browser refused a write because local storage is full. */
export function isQuotaError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const {name, code} = error as { name?: unknown; code?: unknown };
    return (
        // Covers "QuotaExceededError" and legacy "QUOTA_EXCEEDED_ERR"/
        // "NS_ERROR_DOM_QUOTA_REACHED"-style names across engines.
        (typeof name === "string" && name.toUpperCase().includes("QUOTA")) ||
        code === 22 // legacy numeric code for QuotaExceededError
    );
}

/** True when the browser blocked local storage entirely (private mode, disabled). */
export function isStorageBlockedError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const {name} = error as { name?: unknown };
    return (
        name === "SecurityError" ||
        name === "NotSupportedError" ||
        name === "InvalidStateError"
    );
}

/**
 * Turns a raw thrown value into a short, user-facing sentence. Storage
 * failures get concrete guidance; everything else falls back to the error's
 * own message (or `fallback` when there is none).
 */
export function describeStorageError(error: unknown, fallback?: string): string {
    if (isQuotaError(error)) {
        return (
            "Browser storage is full. Free up space (delete old backups or unused " +
            "data in Settings) and try again."
        );
    }
    if (isStorageBlockedError(error)) {
        return (
            "This browser is blocking local storage (private mode?). Leave private " +
            "browsing to save data."
        );
    }
    const message = error instanceof Error ? error.message : String(error);
    return message || (fallback ?? "Something went wrong.");
}

/**
 * Manager-style message: storage failures keep their friendly guidance,
 * other errors get the operation prefix (`"Delete failed: TimeoutError"`).
 */
export function storageAwareMessage(error: unknown, prefix: string): string {
    if (isQuotaError(error) || isStorageBlockedError(error)) {
        return describeStorageError(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return message ? `${prefix}: ${message}` : prefix;
}

// ---------------------------------------------------------------------------
// Usage & durability (navigator.storage)
// ---------------------------------------------------------------------------

export interface StorageUsage {
    /** Bytes used by all app origins, or null when the API is unavailable. */
    usage: number | null;
    /** Bytes the browser is willing to allocate (approximate). */
    quota: number | null;
    /** usage / quota, or null when either is unknown. */
    ratio: number | null;
}

/**
 * Best-effort snapshot of the origin's storage budget. Returns nulls when
 * `navigator.storage.estimate` is unsupported (Safari restricts it) or throws
 * — callers must treat unknown usage as "no indicator", never as an error.
 */
export async function getStorageUsage(): Promise<StorageUsage> {
    try {
        if (!navigator.storage?.estimate) return {usage: null, quota: null, ratio: null};
        const {usage, quota} = await navigator.storage.estimate();
        const u = typeof usage === "number" ? usage : null;
        const q = typeof quota === "number" && quota > 0 ? quota : null;
        return {usage: u, quota: q, ratio: u !== null && q !== null ? u / q : null};
    } catch {
        return {usage: null, quota: null, ratio: null};
    }
}

/** True when the browser has granted (or already has) persistent storage. */
export async function isStoragePersistent(): Promise<boolean | null> {
    try {
        if (!navigator.storage?.persisted) return null;
        return await navigator.storage.persisted();
    } catch {
        return null;
    }
}

/**
 * Ask the browser not to evict this origin's IndexedDB under storage
 * pressure. Browsers grant this silently when the user has "installed" the
 * PWA or added it to the home screen; otherwise it may pop a prompt or just
 * return false. Safe to call from a click handler.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
    try {
        if (!navigator.storage?.persist) return null;
        return await navigator.storage.persist();
    } catch {
        return null;
    }
}

/** Compact human-readable byte count (e.g. "4.2 MB"). */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = "B";
    for (const next of units) {
        value /= 1024;
        unit = next;
        if (value < 1024) break;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

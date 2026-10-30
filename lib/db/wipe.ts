/**
 * Complete local-data wipe (AGENTS.md §2 "Local Only" / privacy guarantees).
 *
 * Removes every app-owned storage area from the browser origin:
 *   - IndexedDB databases (the `peptimania` database and any legacy clones)
 *   - localStorage + sessionStorage
 *   - Cache Storage entries created by the service worker (Serwist precache
 *     and runtime caches, plus any legacy `peptimania-*` caches)
 *   - Service worker registrations
 *
 * Nothing is transmitted anywhere — deletion is purely local. Callers should
 * confirm with the user first and reload the page afterwards.
 */

import {DATABASE_NAME, db} from "./database";

const DB_NAME_PREFIX = "peptimania";

export interface WipeResult {
    /** Deleted IndexedDB database names. */
    databases: string[];
    /** Deleted Cache Storage names. */
    caches: string[];
    /** Whether service worker registrations were unregistered. */
    serviceWorkersRemoved: boolean;
    localStorageCleared: boolean;
    sessionStorageCleared: boolean;
}

/**
 * Best-effort enumeration of this origin's IndexedDB databases (not available
 * in every browser; fallback names cover the known ones across versions).
 */
async function listAppDatabases(): Promise<string[]> {
    const fallback = ["peptimania", "peptimania-db", DATABASE_NAME];
    try {
        const dbs = await indexedDB.databases();
        const names = (dbs ?? [])
            .map((d) => d.name)
            .filter((n): n is string => typeof n === "string" && n.startsWith(DB_NAME_PREFIX));
        return Array.from(new Set([...names, ...fallback]));
    } catch {
        return fallback;
    }
}

export async function wipeAllLocalData(): Promise<WipeResult> {
    const result: WipeResult = {
        databases: [],
        caches: [],
        serviceWorkersRemoved: false,
        localStorageCleared: false,
        sessionStorageCleared: false,
    };

    // Close our Dexie connection first so `deleteDatabase` isn't blocked by
    // an open handle (Dexie queues but an explicit close is deterministic).
    db?.close();

    // 1. IndexedDB
    const names = await listAppDatabases();
    await Promise.all(
        names.map(async (name) => {
            try {
                await new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(name);
                    request.onsuccess = () => {
                        result.databases.push(name);
                        resolve();
                    };
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => resolve(); // best-effort: keep going
                });
            } catch {
                // Non-fatal: the DB may not exist under this name.
            }
        })
    );

    // 2. Web Storage
    try {
        localStorage.clear();
        result.localStorageCleared = true;
    } catch { /* ignore */
    }
    try {
        sessionStorage.clear();
        result.sessionStorageCleared = true;
    } catch { /* ignore */
    }

    // 3. Cache Storage (Serwist precache + runtime caches). This origin only
    // hosts this app, and every cache belongs to its service worker, so delete
    // them all rather than relying on a cache-name prefix.
    try {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((n) => caches.delete(n)));
        result.caches = cacheNames;
    } catch { /* ignore */
    }

    // 4. Service workers
    try {
        if ("serviceWorker" in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((r) => r.unregister()));
            result.serviceWorkersRemoved = registrations.length > 0;
        }
    } catch { /* ignore */
    }

    return result;
}

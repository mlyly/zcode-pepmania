"use client";

import {useEffect} from "react";

/**
 * Registers the service worker once on mount. Uses `updateViaCache: "none"`
 * so HTTP caches never serve a stale worker script, and DEFERs' skipWaiting
 * behind a user-timing-safe message after `waiting` state.
 */
export function ServiceWorkerRegister() {
    useEffect(() => {
        if (process.env.NODE_ENV !== "production") return;
        if (!("serviceWorker" in navigator)) return;

        const register = async () => {
            try {
                const registration = await navigator.serviceWorker.register("/sw.js", {
                    scope: "/",
                    updateViaCache: "none",
                });

                // Surface "waiting" workers so the UI can offer an update prompt.
                registration.addEventListener("updatefound", () => {
                    const installing = registration.installing;
                    installing?.addEventListener("statechange", () => {
                        if (
                            installing.state === "installed" &&
                            navigator.serviceWorker.controller
                        ) {
                            // A new version is ready; a future settings screen can call
                            // postMessage("SKIP_WAITING") via this reference.
                            window.dispatchEvent(
                                new CustomEvent("pwa-update-ready", {detail: registration})
                            );
                        }
                    });
                });
            } catch (error) {
                console.error("[pwa] service worker registration failed:", error);
            }
        };

        void register();
    }, []);

    return null;
}

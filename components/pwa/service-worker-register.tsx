"use client";

import {useEffect} from "react";

/**
 * Registers the Serwist service worker in production builds.
 *
 * Notes for iOS:
 *  - The worker is built as a classic (IIFE) script, so it must NOT be
 *    registered with `{type: "module"}` — WebKit only supports classic workers.
 *  - Registration is deferred until the page has loaded so it never competes
 *    with the first paint on slower iOS devices.
 *  - `updateViaCache: "none"` keeps HTTP caches from serving a stale worker.
 */
export function ServiceWorkerRegister() {
    useEffect(() => {
        if (process.env.NODE_ENV !== "production") return;
        if (typeof window === "undefined") return;
        if (!("serviceWorker" in navigator)) return;

        let disposed = false;
        let refreshing = false;
        const hadController = Boolean(navigator.serviceWorker.controller);

        const register = async () => {
            if (disposed) return;
            try {
                const registration = await navigator.serviceWorker.register("/sw.js", {
                    scope: "/",
                    updateViaCache: "none",
                });
                if (disposed) return;

                // Surface "waiting" workers so the UI can offer an update prompt.
                registration.addEventListener("updatefound", () => {
                    const installing = registration.installing;
                    installing?.addEventListener("statechange", () => {
                        if (
                            installing.state === "installed" &&
                            navigator.serviceWorker.controller
                        ) {
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

        // A newer worker taking control can invalidate old, code-split chunks.
        // Reload once on updates (but not on the very first install) so an
        // installed iOS PWA never ends up running a mixture of two builds.
        const onControllerChange = () => {
            if (!hadController || refreshing) return;
            refreshing = true;
            window.location.reload();
        };
        navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

        if (document.readyState === "complete") {
            void register();
        } else {
            window.addEventListener("load", register, {once: true});
        }

        return () => {
            disposed = true;
            window.removeEventListener("load", register);
            navigator.serviceWorker.removeEventListener(
                "controllerchange",
                onControllerChange
            );
        };
    }, []);

    return null;
}

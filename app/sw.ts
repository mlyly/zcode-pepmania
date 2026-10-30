/// <reference lib="webworker" />

import {defaultCache} from "@serwist/next/worker";
import type {PrecacheEntry, SerwistGlobalConfig} from "serwist";
import {Serwist} from "serwist";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        // Replaced at build time by `serwist build` with the generated
        // precache manifest (see `serwist.config.ts`).
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    // Activate new versions immediately and take control of open pages. This
    // matters on iOS, where a standalone PWA can stay "open" for days and a
    // waiting worker would otherwise never activate.
    skipWaiting: true,
    clientsClaim: true,
    // Safari/WebKit does not implement the Navigation Preload API. Enabling it
    // is a no-op at best and breaks offline navigations at worst.
    navigationPreload: false,
    runtimeCaching: defaultCache,
    precacheOptions: {
        cleanupOutdatedCaches: true,
        // The manifest uses clean route URLs (`/medications`, `/dose-logs`).
        // `cleanURLs` also lets a request for `/medications.html` (or an older
        // bookmark) resolve to the same precached route.
        cleanURLs: true,
        // Ignore query parameters so iOS launch tracking (`?source=pwa`) and
        // cache-busting strings still hit the precached route instead of
        // falling through to the network.
        ignoreURLParametersMatching: [/.*/],
        // If a navigation was not precached (deep link, unknown path, or a
        // route added after this worker was installed), boot the app shell.
        // This is what lets an installed iOS PWA open while fully offline.
        navigateFallback: "/",
    },
    fallbacks: {
        entries: [
            {
                url: "/",
                matcher({request}) {
                    return request.destination === "document";
                },
            },
        ],
    },
});

serwist.addEventListeners();

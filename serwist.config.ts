import {serwist} from "@serwist/next/config";

/**
 * Serwist configuration for this static-exported Next.js app.
 *
 * Next 16 builds with Turbopack by default, and `@serwist/next`'s webpack
 * wrapper cannot run there. Serwist's Turbopack-compatible "configurator mode"
 * generates the worker from the exported `out/` directory after `next build`
 * (see the `build` script in package.json).
 */
export default await serwist({
    swSrc: "app/sw.ts",
    // The static export is what gets deployed, so the worker must live there.
    swDest: "out/sw.js",
    globDirectory: "out",
    // Precache the whole exported app: HTML routes, RSC `.txt` payloads,
    // hashed `_next` assets, icons and the manifest. `next build` removes
    // `out/` first, so stale files cannot leak into the manifest.
    globPatterns: ["**/*"],
    globIgnores: [
        "sw.js",
        "sw.js.map",
        "**/*.map",
        "404.html",
        "_not-found.html",
        // Serwist generates this file into `out/`; never precache it.
        "**/sw.js",
    ],
    // Normalize every manifest URL to an absolute path. `@serwist/next`'s
    // configurator then maps `.html` entries onto clean route URLs
    // (`medications.html` → `/medications`), matching what the browser requests
    // and what `next/link` navigates to. (Static hosts therefore need to serve
    // extensionless routes, which the app already relies on online.)
    manifestTransforms: [
        (entries) => ({
            manifest: entries.map((entry) => {
                const url = entry.url === "index.html" ? "/" : `/${entry.url}`;
                return {...entry, url};
            }),
            warnings: [],
        }),
    ],
    // Content-hashed Next assets never change under the same URL.
    dontCacheBustURLsMatching: /^_next\/static\//,
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    // The export already contains every prerendered route in `out/`.
    precachePrerendered: false,
    esbuildOptions: {
        // iOS/WebKit only supports classic service workers. The CLI defaults
        // to `esm`, which Safari refuses to register. Ship an IIFE instead.
        format: "iife",
        target: ["safari15"],
        // Serwist's development logging checks `process.env.NODE_ENV`; there
        // is no `process` inside a browser worker.
        define: {
            "process.env.NODE_ENV": '"production"',
        },
    },
});

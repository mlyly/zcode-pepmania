"use client";

import {describeStorageError} from "@/lib/db/quota";

/**
 * Last-resort boundary for errors in the root layout itself. Replaces the
 * whole document, so it carries its own <html>/<body> and cannot rely on
 * globals.css — styles are inline and deliberately minimal.
 */
export default function GlobalError({error, retry}: { error: unknown; retry: () => void }) {
    return (
        <html lang="en">
        <body style={{margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center"}}>
        <main style={{maxWidth: "26rem", padding: "1.5rem", textAlign: "center", fontFamily: "system-ui, sans-serif"}}>
            <h1 style={{fontSize: "1.125rem", fontWeight: 600, margin: "0 0 0.5rem"}}>
                Peptimania hit an unexpected error
            </h1>
            <p style={{fontSize: "0.875rem", opacity: 0.7, margin: "0 0 1rem"}}>
                {describeStorageError(error, "Your data is safe in this browser — reloading should restore the app.")}
            </p>
            <button
                type="button"
                onClick={retry}
                style={{
                    fontSize: "0.875rem", fontWeight: 500, cursor: "pointer",
                    padding: "0.625rem 1.25rem", borderRadius: "0.5rem", border: "none",
                    background: "currentColor", color: "Canvas",
                }}
            >
                Reload the app
            </button>
        </main>
        </body>
        </html>
    );
}

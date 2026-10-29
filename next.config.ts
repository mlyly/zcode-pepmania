import type {NextConfig} from "next";

const nextConfig: NextConfig = {
    // The app is fully client-side (IndexedDB only, zero backend), so we ship a
    // static export that can be hosted anywhere and cached by the service worker.
    output: "export",
    // `next/image`'s default optimization server doesn't exist in a static
    // export; use unoptimized images instead.
    images: {
        unoptimized: true,
    },
    experimental: {
        // Keeps navigations/fetches pending while offline and retries once
        // connectivity returns, instead of throwing in the client.
        useOffline: true,
    },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

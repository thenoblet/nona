import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for the Dokploy Docker image.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    // WebP only. Cloudflare caches /_next/image at the edge, and its free plan keeps one
    // copy per URL whatever the browser accepts, so an AVIF copy could reach iPhones
    // on iOS 15 that can't show it. Every phone guests will have shows WebP.
    formats: ["image/webp"],
    // Guest media will be served from R2 later, e.g.
    // remotePatterns: [new URL("https://media.nobletxnancy.com/**")],
  },
  // The link preview cards are prerendered, but may be redrawn on the server after their
  // cache lifetime, so the server build must carry the fonts they are drawn with.
  outputFileTracingIncludes: {
    "/opengraph-image": ["src/fonts/og/**/*"],
    "/*/opengraph-image*": ["src/fonts/og/**/*"],
  },
  // Files in public/ have no hash in their names, so Next sends max-age=0 and Cloudflare
  // asks the server again on every request. A week lets the Accra edge keep them; rename
  // a file (or purge Cloudflare) when it changes.
  async headers() {
    const week = { key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" };
    return [
      { source: "/images/:path*", headers: [week] },
      { source: "/audio/:path*", headers: [week] },
      // A personal link's question names its guest: never in a shared cache, never in a search index.
      // Next keeps a Cache-Control set here rather than writing its own.
      {
        source: "/my/:token/confirm",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
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

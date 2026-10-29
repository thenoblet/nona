import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for the Dokploy Docker image.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    formats: ["image/avif", "image/webp"],
    // Guest media will be served from CloudFront later, e.g.
    // remotePatterns: [new URL("https://media.nobletxnancy.com/**")],
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

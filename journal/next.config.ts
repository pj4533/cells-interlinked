import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The journal is static — every report is read from disk at build
  // time, no runtime API. Output as a fully static site so Vercel
  // can serve from CDN edges with zero compute.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;

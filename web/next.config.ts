import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hitting the dev server from another machine on the LAN (e.g. a laptop opening
  // http://pjs-mac-studio.local:3001) is blocked by default in Next 16. Allow
  // *.local Bonjour names plus the common private-IP ranges.
  allowedDevOrigins: [
    "pjs-mac-studio.local",
    "*.local",
    "192.168.0.0/16",
    "10.0.0.0/8",
  ],
};

export default nextConfig;

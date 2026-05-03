import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hitting the dev server from another machine on the LAN (e.g. a laptop
  // opening http://your-host.local:3001 or http://192.168.x.x:3001) is
  // blocked by default in Next 16. `allowedDevOrigins` uses micromatch
  // glob patterns — NOT CIDR notation. (Earlier versions of this file
  // used "192.168.0.0/16"; that was treated as a literal string and
  // matched nothing, breaking HMR for any LAN access including from
  // mobile Safari.)
  allowedDevOrigins: [
    "*.local",
    // RFC 1918 private IPv4 ranges, expressed per-octet:
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
};

export default nextConfig;

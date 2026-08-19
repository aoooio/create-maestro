import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The scheduler worker is bundled by Next through `new Worker(new URL(...))`,
  // which needs no extra configuration; nothing else here is optional.
  experimental: {
    typedRoutes: true,
  },
  allowedDevOrigins: [
    "192.168.1.108",
    "10.x.*.*",
    "172.x.x.x",
    "127.0.0.1",
    "localhost",
  ],
};

export default config;

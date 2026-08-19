import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The scheduler worker is bundled by Next through `new Worker(new URL(...))`,
  // which needs no extra configuration; nothing else here is optional.
  experimental: {
    typedRoutes: true,
  },
};

export default config;

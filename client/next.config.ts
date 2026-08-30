import os from "node:os";
import type { NextConfig } from "next";

function lanHosts(): string[] {
  const hosts: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) hosts.push(addr.address);
    }
  }
  return hosts;
}

const config: NextConfig = {
  reactStrictMode: true,
  // Phones on the same Wi-Fi hit the dev server by LAN IP; Next blocks that
  // origin unless it is listed here.
  allowedDevOrigins: lanHosts(),
  // The scheduler worker is bundled by Next through `new Worker(new URL(...))`,
  // which needs no extra configuration; nothing else here is optional.
  experimental: {
    typedRoutes: true,
  },
};

export default config;

import type { NextConfig } from "next";
import { securityHeaders } from "./src/server/security-headers.ts";

const config: NextConfig = {
  reactStrictMode: true,
  // node:sqlite and child_process are server-only; keep them out of client bundles.
  serverExternalPackages: ["@opencode/sdk", "@opencode/plugin"],
  // S0-4 (SEC-16): CSP + response hardening on every route.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "development") }];
  },
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"],
    // Next's dev MCP server writes every browser log line to .next/dev/logs; the watcher reacts and the page reload-loops.
    mcpServer: false,
  },
};

export default config;

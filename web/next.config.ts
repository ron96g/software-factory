import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // node:sqlite and child_process are server-only; keep them out of client bundles.
  serverExternalPackages: ["@opencode/sdk", "@opencode/plugin"],
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"],
    // Next's dev MCP server writes every browser log line to .next/dev/logs; the watcher reacts and the page reload-loops.
    mcpServer: false,
  },
};

export default config;

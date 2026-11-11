import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // node:sqlite and child_process are server-only; keep them out of client bundles.
  serverExternalPackages: [],
  experimental: { optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"] },
};

export default config;

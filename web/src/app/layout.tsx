import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { COLOR_SCHEME_COOKIE, isColorScheme } from "@/ui/color-scheme.ts";
import { Providers } from "@/ui/providers.tsx";

export const metadata: Metadata = {
  title: "Software Factory",
  description: "AI-driven development lifecycle as code",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const stored = (await cookies()).get(COLOR_SCHEME_COOKIE)?.value;
  // "auto" can't be resolved on the server; fall back to light (ADR-0018 default).
  const scheme = isColorScheme(stored) && stored !== "auto" ? stored : "light";
  return (
    <html lang="en" data-mantine-color-scheme={scheme} suppressHydrationWarning>
      <body>
        <Providers colorScheme={scheme}>{children}</Providers>
      </body>
    </html>
  );
}

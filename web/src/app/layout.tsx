import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type { Metadata } from "next";
import { theme } from "@/ui/theme.ts";
import { Shell } from "@/ui/shell.tsx";

export const metadata: Metadata = {
  title: "Software Factory · AI-DLC",
  description: "AI-driven development lifecycle as code",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript forceColorScheme="dark" />
      </head>
      <body>
        <MantineProvider theme={theme} forceColorScheme="dark">
          <Notifications position="top-right" />
          <Shell>{children}</Shell>
        </MantineProvider>
      </body>
    </html>
  );
}

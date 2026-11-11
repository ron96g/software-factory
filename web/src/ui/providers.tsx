"use client";
import { MantineProvider, type MantineColorScheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { useState } from "react";
import { cookieColorSchemeManager } from "./color-scheme.ts";
import { Shell } from "./shell.tsx";
import { theme } from "./theme.ts";

export function Providers({ colorScheme, children }: { colorScheme: MantineColorScheme; children: React.ReactNode }) {
  const [manager] = useState(cookieColorSchemeManager);
  return (
    <MantineProvider theme={theme} defaultColorScheme={colorScheme} colorSchemeManager={manager}>
      <Notifications position="bottom-right" />
      <Shell>{children}</Shell>
    </MantineProvider>
  );
}

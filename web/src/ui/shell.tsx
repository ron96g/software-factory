"use client";
import { ActionIcon, AppShell, Group, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconMoon, IconSun, IconTopologyStar3 } from "@tabler/icons-react";
import Link from "next/link";
import { useLiveStatus } from "./api.ts";

export function Shell({ children }: { children: React.ReactNode }) {
  const live = useLiveStatus();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  return (
    <AppShell header={{ height: 52 }} padding="lg">
      <AppShell.Header className="sf-header">
        <Group h="100%" px="lg" justify="space-between">
          <UnstyledButton component={Link} href="/">
            <Group gap={8}>
              <IconTopologyStar3 size={20} stroke={1.7} color="var(--mantine-primary-color-filled)" />
              <Text fw={600} size="sm">
                Software Factory
              </Text>
              <Text size="xs" c="dimmed">
                AI-DLC
              </Text>
            </Group>
          </UnstyledButton>
          <Group gap="sm">
            <Tooltip label={live ? "Live updates connected" : "Live updates disconnected"}>
              <Group gap={6}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: live ? "var(--mantine-color-teal-6)" : "var(--mantine-color-gray-5)",
                  }}
                />
                <Text size="xs" c="dimmed">
                  {live ? "Live" : "Offline"}
                </Text>
              </Group>
            </Tooltip>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Toggle color scheme"
              onClick={() => setColorScheme(scheme === "light" ? "dark" : "light")}
            >
              {scheme === "light" ? <IconMoon size={16} /> : <IconSun size={16} />}
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

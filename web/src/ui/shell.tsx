"use client";
import { AppShell, Badge, Group, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { IconRocket } from "@tabler/icons-react";
import Link from "next/link";
import { useLiveStatus } from "./api.ts";

export function Shell({ children }: { children: React.ReactNode }) {
  const live = useLiveStatus();
  return (
    <AppShell header={{ height: 60 }} padding="lg">
      <AppShell.Header className="sf-glass">
        <Group h="100%" px="lg" justify="space-between">
          <UnstyledButton component={Link} href="/">
            <Group gap="sm">
              <ThemeIcon variant="gradient" gradient={{ from: "nebula", to: "plasma", deg: 135 }} radius="xl" size="lg">
                <IconRocket size={20} />
              </ThemeIcon>
              <div>
                <Text fw={700} ff="heading" className="sf-glow" lh={1.1}>
                  Software Factory
                </Text>
                <Text size="xs" c="dimmed" lh={1.1}>
                  AI-DLC mission control
                </Text>
              </div>
            </Group>
          </UnstyledButton>
          <Badge variant="dot" color={live ? "teal" : "gray"}>
            {live ? "live" : "offline"}
          </Badge>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

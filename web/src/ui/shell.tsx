"use client";
import { ActionIcon, AppShell, Badge, Group, Stack, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconBox, IconBrain, IconMoon, IconSun, IconTopologyStar3 } from "@tabler/icons-react";
import Link from "next/link";
import type { SystemHealth } from "@/core/ports/app.ts";
import { useLive, useLiveStatus } from "./api.ts";

function HealthBadges() {
  const { data } = useLive<SystemHealth>("/api/system/health", () => false);
  if (!data) return null;
  const sb = data.sandbox;
  return (
    <Group gap={6}>
      <Tooltip
        multiline
        w={340}
        label={
          <Stack gap={2}>
            <Text size="xs" fw={600}>
              Sandbox runtime (ADR-0019)
            </Text>
            <Text size="xs">{sb.available ? `${sb.runtime} · isolation ${sb.isolation}` : sb.message}</Text>
            {!sb.available && <Text size="xs">Construction agents run simulated. Set FACTORY_SANDBOX_RUNTIME.</Text>}
          </Stack>
        }
      >
        <Badge variant="light" color={sb.available ? "teal" : "gray"} leftSection={<IconBox size={12} />}>
          {sb.available ? sb.runtime : "no sandbox"}
        </Badge>
      </Tooltip>
      <Tooltip label={data.llm.available ? `${data.llm.provider} · ${data.llm.model}` : "No ModelProvider key configured: deterministic/simulated agents"}>
        <Badge variant="light" color={data.llm.available ? "teal" : "gray"} leftSection={<IconBrain size={12} />}>
          {data.llm.available ? data.llm.provider : "no LLM"}
        </Badge>
      </Tooltip>
    </Group>
  );
}

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
            <HealthBadges />
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

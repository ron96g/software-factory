"use client";
import { ActionIcon, AppShell, Badge, Group, Stack, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconAlertTriangle, IconBox, IconBrain, IconMoon, IconSun, IconTopologyStar3 } from "@tabler/icons-react";
import Link from "next/link";
import type { SystemHealth } from "@/core/ports/app.ts";
import { useLive, useLiveStatus } from "./api.ts";
import { Navbar } from "./navbar.tsx";

function HealthBadges() {
  const { data, reload } = useLive<SystemHealth>("/api/system/health", (n) => n.kind === "Event");
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
        <Badge variant={sb.waivesIsolation ? "filled" : "light"} color={sb.waivesIsolation ? "red" : sb.available ? "teal" : "gray"} leftSection={<IconBox size={12} />}>
          {sb.waivesIsolation ? `${sb.runtime} · unsandboxed` : sb.available ? sb.runtime : "no sandbox"}
        </Badge>
      </Tooltip>
      {data.failing.length > 0 && (
        <Tooltip
          multiline
          w={420}
          label={
            <Stack gap={4}>
              {data.failing.slice(0, 6).map((f) => (
                <Text key={`${f.controller}|${f.key}`} size="xs">
                  <b>{f.controller}</b> {f.key} · {f.attempts}× · {f.lastError.slice(0, 160)}
                </Text>
              ))}
            </Stack>
          }
        >
          <Badge variant="filled" color="red" leftSection={<IconAlertTriangle size={12} />}>
            {data.failing.length} failing
          </Badge>
        </Tooltip>
      )}
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
    <AppShell header={{ height: 52 }} navbar={{ width: 230, breakpoint: "sm" }} padding="lg">
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
      <AppShell.Navbar className="sf-header">
        <Navbar />
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

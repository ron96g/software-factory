"use client";
import { ActionIcon, AppShell, Badge, Group, Stack, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconAlertTriangle, IconBox, IconBrain, IconMoon, IconSun, IconTopologyStar3 } from "@tabler/icons-react";
import Link from "next/link";
import type { SystemHealth } from "@/core/ports/app.ts";
import { useLive, useLiveStatus } from "./api.ts";
import { Navbar } from "./navbar.tsx";
import { NotificationBell, NotificationBridge } from "./notifications.tsx";

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
        <Badge variant="light" color={sb.available ? "teal" : "gray"} leftSection={<IconBox size={12} />}>
          {sb.available ? sb.runtime : "no sandbox"}
        </Badge>
      </Tooltip>
      <Tooltip
        multiline
        w={420}
        label={
          <Stack gap={4}>
            <Text fw={600}>Check worker (ADR-0062)</Text>
            <Text size="xs">
              {data.checks.workers === 0
                ? data.role === "web"
                  ? "No check worker is running: checks stay Pending until one starts (npm run worker)."
                  : "This process runs checks but its worker heartbeat is missing — checks may stay Pending."
                : `${data.checks.workers} worker(s), ${data.checks.running} check(s) running.`}
            </Text>
          </Stack>
        }
      >
        <Badge variant="light" color={data.checks.workers === 0 ? "gray" : "teal"} leftSection={<IconBox size={12} />}>
          {data.checks.workers === 0 ? "no check worker" : `${data.checks.workers} worker${data.checks.workers === 1 ? "" : "s"}`}
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
      {data.toolGaps?.length > 0 && (
        <Tooltip
          multiline
          w={420}
          label={
            <Stack gap={4}>
              <Text size="xs">ADR-0088: these tools are declared by a repository's sandbox profile but are not in the factory's toolchain cache yet. They are installed the next time a sandbox is prepared (declared tools must be provisioned before a check can use them).</Text>
              {data.toolGaps.slice(0, 8).map((g) => (
                <Text key={`${g.repository}/${g.tool}`} size="xs">
                  <b>{g.repository}/{g.tool}</b> · {g.type}
                </Text>
              ))}
            </Stack>
          }
        >
          <Badge variant="light" color="yellow" leftSection={<IconBox size={12} />}>
            {data.toolGaps.length} tool gap{data.toolGaps.length === 1 ? "" : "s"}
          </Badge>
        </Tooltip>
      )}
      {data.policyGaps?.length > 0 && (
        <Tooltip
          multiline
          w={420}
          label={
            <Stack gap={4}>
              <Text size="xs">Repository policy relies on these checks, but they have no configured command. They can never pass; waivable ones need a human waiver on every item.</Text>
              {data.policyGaps.slice(0, 8).map((g) => (
                <Text key={`${g.repository}/${g.check}/${g.role}`} size="xs">
                  <b>{g.repository}/{g.check}</b> · {g.role}{g.waivable ? " · waivable" : " · not waivable"}
                </Text>
              ))}
            </Stack>
          }
        >
          <Badge variant="light" color={data.policyGaps.some((g) => !g.waivable) ? "red" : "yellow"} leftSection={<IconAlertTriangle size={12} />}>
            {data.policyGaps.length} check gap{data.policyGaps.length === 1 ? "" : "s"}
          </Badge>
        </Tooltip>
      )}
      <Tooltip
        label={
          data.llm.available
            ? `${data.llm.provider} · ${data.llm.model}`
            : data.simulation === "wait"
              ? "No ModelProvider key configured: agent runs that need an LLM wait (FACTORY_SIMULATION=wait)"
              : "No ModelProvider key configured: deterministic/simulated agents"
        }
      >
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
            <NotificationBell />
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
      <NotificationBridge />
    </AppShell>
  );
}

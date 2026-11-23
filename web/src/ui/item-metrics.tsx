"use client";
import { Badge, Card, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { IconChartBar } from "@tabler/icons-react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { ItemMetrics } from "@/core/ports/metrics.ts";
import { useLive } from "@/ui/api.ts";

const ms = (n?: number) => (n === undefined ? "—" : n < 1000 ? `${n} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : `${(n / 60_000).toFixed(1)} m`);
const n = (v?: number) => (v === undefined ? "—" : v.toLocaleString());

/** ADR-0082: a compact per-item metrics summary. Recorded values only — an unknown value shows "—". */
export function ItemMetricsPanel({ item }: { item: WorkItem }) {
  const { data } = useLive<ItemMetrics>(`/api/workitems/${item.metadata.name}/metrics`, (c) => c.workItem === item.metadata.name);
  if (!data || data.runs.length === 0) return null;
  const tools = Object.entries(data.totals.tools).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  const stat = (label: string, value: string) => (
    <div><Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text><Text fz={20} fw={700}>{value}</Text></div>
  );
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs">
        <Group gap={6}><IconChartBar size={16} /><Text fw={600} size="sm">Metrics</Text></Group>
        <Badge variant="light" color="gray" size="sm">{data.totals.runs} runs</Badge>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="sm">
        {stat("In agent", ms(data.totals.agentMs))}
        {stat("In tools", ms(data.totals.toolMs))}
        {stat("Tokens", data.totals.tokens ? n(data.totals.tokens.total) : "—")}
        {stat("Cost", data.totals.costUsd === undefined ? "—" : `$${data.totals.costUsd.toFixed(4)}${data.totals.costEstimated ? " est." : ""}`)}
      </SimpleGrid>
      <Stack gap={6}>
        <Group gap="xs" wrap="wrap">
          {tools.length ? tools.map(([name, t]) => (
            <Badge key={name} variant="light" color="gray" size="sm">{name} · {t.calls}{t.ms !== undefined ? ` · ${ms(t.ms)}` : ""}</Badge>
          )) : <Text size="xs" c="dimmed">No tool calls recorded.</Text>}
        </Group>
        {data.checks.length > 0 && (
          <Table fz="xs">
            <Table.Tbody>
              {data.checks.map((c) => (
                <Table.Tr key={c.check}>
                  <Table.Td>{c.check}</Table.Td>
                  <Table.Td>{c.runs}×{c.failed ? ` (${c.failed} failed)` : ""}</Table.Td>
                  <Table.Td>{ms(c.ms)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}

"use client";

import { Alert, Badge, Card, Group, List, Progress, Stack, Table, Text, Title } from "@mantine/core";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { UnitProgressView, UnitState } from "@/core/ports/units.ts";
import { useLive } from "./api.ts";

const COLORS: Record<UnitState, string> = { pending: "gray", implementing: "blue", checking: "violet", ready: "teal", blocked: "red" };

/** ADR-0047: approved Units, the one being implemented and why review has not started yet. */
export function UnitProgressPanel({ item }: { item: WorkItem }) {
  const url = `/api/workitems/${encodeURIComponent(item.metadata.name)}/units`;
  const { data, error } = useLive<UnitProgressView>(url, (n) => n.workItem === item.metadata.name || ["Workflow", "Repository"].includes(n.kind ?? ""));
  if (!data?.enabled && !error) return null;
  const ready = data?.units.filter((u) => u.state === "ready").length ?? 0;
  const total = data?.units.length ?? 0;
  return <Card className="sf-surface">
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Units of work</Title>
        {total > 0 && <Text size="sm">{ready} of {total} done</Text>}
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {data?.error && <Alert color="yellow" title="Unit execution needs an approved Unit manifest">{data.error}</Alert>}
      {total > 0 && <Progress value={(ready / total) * 100} color={ready === total ? "teal" : "blue"} />}
      {data?.barrier && !data.barrier.satisfied && total > 0 && ready === total && (
        <Alert color="violet" title="Review starts after the final readiness checks">
          <List size="sm" mt={4}>{data.barrier.missing.slice(0, 8).map((m) => <List.Item key={m}>{m}</List.Item>)}</List>
        </Alert>
      )}
      {data?.barrier?.satisfied && <Text size="sm" c="teal">All Units ready; review can start.</Text>}
      {total > 0 && <Table striped withTableBorder>
        <Table.Thead><Table.Tr><Table.Th>Unit</Table.Th><Table.Th>State</Table.Th><Table.Th>Depends on</Table.Th><Table.Th>Readiness checks</Table.Th><Table.Th>Needs attention</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {data!.units.map((u) => <Table.Tr key={u.unit.id}>
            <Table.Td><Text size="sm" fw={600}>{u.unit.id}</Text><Text size="xs" c="dimmed">{u.unit.title}</Text></Table.Td>
            <Table.Td><Badge color={COLORS[u.state]} variant="light">{u.state}</Badge></Table.Td>
            <Table.Td><Text size="xs">{u.unit.dependsOn.join(", ") || "–"}</Text></Table.Td>
            <Table.Td><Stack gap={2}>{u.checks.map((c) => <Text key={c.id} size="xs">{c.id}: {c.outcome ?? "not run"}</Text>)}</Stack></Table.Td>
            <Table.Td><Text size="xs">{u.state === "blocked" || (u.state === "pending" && u.attempt) ? u.diagnostics.slice(0, 3).join("; ") || "–" : "–"}</Text></Table.Td>
          </Table.Tr>)}
        </Table.Tbody>
      </Table>}
    </Stack>
  </Card>;
}

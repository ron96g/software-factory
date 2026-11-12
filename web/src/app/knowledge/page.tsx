"use client";
import { Anchor, Badge, Card, Group, SegmentedControl, Stack, Table, Text, Title } from "@mantine/core";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { KnowledgeEntry } from "@/core/model/kinds.ts";
import { useLive } from "@/ui/api.ts";
import { PhaseBadge, timeAgo } from "@/ui/badges.tsx";

const FILTERS = { review: "Needs review", approved: "Approved", all: "All" } as const;

export default function KnowledgePage() {
  const { data: entries } = useLive<KnowledgeEntry[]>("/api/knowledge", (n) => n.kind === "KnowledgeEntry");
  const [filter, setFilter] = useState<keyof typeof FILTERS>("review");
  const proposed = (entries ?? []).filter((e) => (e.status?.phase ?? "Proposed") === "Proposed").length;
  const rows = useMemo(() => {
    const all = entries ?? [];
    if (filter === "review") return all.filter((e) => (e.status?.phase ?? "Proposed") === "Proposed");
    if (filter === "approved") return all.filter((e) => e.status?.phase === "Approved");
    return all;
  }, [entries, filter]);

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <div>
        <Title order={2}>Knowledge</Title>
        <Text c="dimmed" size="sm">
          Agents propose what they learned. Nothing is used by other agents until a human approves it (ADR-0030).
        </Text>
      </div>
      <Group justify="space-between">
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as keyof typeof FILTERS)}
          data={Object.entries(FILTERS).map(([value, label]) => ({ value, label: value === "review" && proposed ? `${label} (${proposed})` : label }))}
        />
        <Text size="sm" c="dimmed">
          {rows.length} entr{rows.length === 1 ? "y" : "ies"}
        </Text>
      </Group>
      <Card className="sf-surface" p={0}>
        <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Entry</Table.Th>
              <Table.Th>Tags</Table.Th>
              <Table.Th>Scope</Table.Th>
              <Table.Th>Proposed by</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((e) => (
              <Table.Tr key={e.metadata.name}>
                <Table.Td>
                  <Anchor component={Link} href={`/knowledge/${e.metadata.name}`} fw={500} size="sm">
                    {e.spec.title}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {(e.spec.tags ?? []).map((t) => (
                      <Badge key={t} size="xs" variant="outline" color="gray">
                        {t}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {[...(e.spec.scope?.repositories ?? []), ...(e.spec.scope?.workflows ?? [])].join(", ") || "everywhere"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{e.spec.provenance?.agent ?? "–"}</Text>
                  {e.spec.provenance?.workItem && (
                    <Text size="xs" c="dimmed" ff="monospace">
                      {e.spec.provenance.workItem}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <PhaseBadge phase={e.status?.phase ?? "Proposed"} size="xs" />
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {timeAgo(e.metadata.creationTimestamp)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text ta="center" c="dimmed" py="xl">
                    {entries === null ? "Loading…" : filter === "review" ? "Nothing to review. Agents propose knowledge while they work." : "No entries here yet."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}

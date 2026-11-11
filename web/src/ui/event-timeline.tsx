"use client";
import { Badge, Card, Group, ScrollArea, SegmentedControl, Text, Timeline, Title, Tooltip } from "@mantine/core";
import { useMemo, useState } from "react";
import type { FactoryEvent } from "@/core/model/kinds.ts";
import { timeAgo } from "./badges.tsx";

/** Routine run lifecycle noise; everything else (stage changes, human input, warnings, PRs, checks) is a key event. */
const ROUTINE = new Set(["Started", "Succeeded", "Preparing", "Synced"]);

const FILTERS = {
  key: { label: "Key events", test: (e: FactoryEvent) => e.spec.type === "Warning" || !ROUTINE.has(e.spec.reason) },
  all: { label: "All", test: () => true },
  warnings: { label: "Warnings", test: (e: FactoryEvent) => e.spec.type === "Warning" },
} as const;

const COLOR: Record<string, string> = {
  StageStarted: "indigo",
  Approved: "teal",
  Rejected: "red",
  Blocked: "orange",
  Resumed: "teal",
  AwaitingApproval: "yellow",
  Completed: "teal",
  CheckPassed: "teal",
  Delivered: "teal",
};

/** Newest first, filtered, in a fixed-height scroll area so long items keep the page short (X2). */
export function EventTimeline({ events, height = "60vh" }: { events: FactoryEvent[]; height?: string }) {
  const [filter, setFilter] = useState<keyof typeof FILTERS>("key");
  const warnings = events.filter(FILTERS.warnings.test).length;
  const shown = useMemo(() => [...events].reverse().filter(FILTERS[filter].test), [events, filter]);
  return (
    <Card className="sf-surface" p="sm">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Title order={5}>Timeline</Title>
        <Text size="xs" c="dimmed">
          {shown.length}/{events.length}
        </Text>
      </Group>
      <SegmentedControl
        size="xs"
        fullWidth
        mb="sm"
        value={filter}
        onChange={(v) => setFilter(v as keyof typeof FILTERS)}
        data={Object.entries(FILTERS).map(([value, f]) => ({
          value,
          label: value === "warnings" && warnings ? `${f.label} (${warnings})` : f.label,
        }))}
      />
      <ScrollArea.Autosize mah={height} type="auto" offsetScrollbars>
        <Timeline bulletSize={10} lineWidth={1} pl={4}>
          {shown.map((e) => (
            <Timeline.Item
              key={e.metadata.name}
              color={e.spec.type === "Warning" ? "red" : (COLOR[e.spec.reason] ?? "gray")}
              title={
                <Group gap={6} wrap="nowrap" justify="space-between">
                  <Text size="xs" fw={600} truncate>
                    {e.spec.reason}
                    <Text span size="xs" c="dimmed" fw={400}>
                      {" "}
                      · {e.spec.involvedObject.kind}
                    </Text>
                  </Text>
                  <Tooltip label={e.metadata.creationTimestamp ? new Date(e.metadata.creationTimestamp).toLocaleString() : ""}>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      {timeAgo(e.metadata.creationTimestamp)}
                    </Text>
                  </Tooltip>
                </Group>
              }
            >
              {e.spec.message && (
                <Tooltip label={e.spec.message} multiline w={360} openDelay={400} disabled={e.spec.message.length < 90}>
                  <Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: "pre-line" }}>
                    {e.spec.message}
                  </Text>
                </Tooltip>
              )}
            </Timeline.Item>
          ))}
          {!shown.length && (
            <Text size="xs" c="dimmed">
              No events for this filter.
            </Text>
          )}
        </Timeline>
      </ScrollArea.Autosize>
      {filter === "key" && events.length > shown.length && (
        <Badge variant="light" color="gray" size="xs" mt="xs">
          {events.length - shown.length} routine events hidden
        </Badge>
      )}
    </Card>
  );
}

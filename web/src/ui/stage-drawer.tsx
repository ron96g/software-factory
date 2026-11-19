"use client";
import { Alert, Anchor, Badge, Drawer, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { CheckRun } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import { useLive } from "./api.ts";
import { PhaseBadge } from "./badges.tsx";
import { deriveStageState, type StageState } from "./stage-state.ts";

const PUBLICATION_COLOR: Record<string, string> = { Delivered: "teal", Failed: "red", Pending: "yellow", Delivering: "blue", "not-configured": "gray", "not-started": "gray" };
const HUMAN_COLOR: Record<string, string> = { approve: "teal", reject: "red", answered: "teal", pending: "yellow", open: "orange", superseded: "gray" };
const duration = (ms?: number) => (ms == null ? "" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/** Live check runs of an item (shared by the stage summary and the stage drawer). */
export function useItemCheckRuns(name: string): CheckRun[] {
  const { data } = useLive<{ runs: CheckRun[] }>(`/api/workitems/${encodeURIComponent(name)}/checks`,
    (n) => n.kind === "CheckRun" || n.workItem === name);
  return data?.runs ?? [];
}

/** One line under the stage progress: what the current stage waits for, with a link to its details. */
/** `waitingFor` overrides the derived text when the page knows more, e.g. a plan gate that waits for answers (ADR-0072). */
export function CurrentStageSummary({ d, checks, onOpen, waitingFor }: { d: WorkItemDetail; checks: CheckRun[]; onOpen: (stage: string) => void; waitingFor?: string }) {
  const stage = d.workItem.status?.stage;
  if (!stage || ["Done", "Failed"].includes(d.workItem.status?.phase ?? "")) return null;
  const derived = deriveStageState(d, checks, stage);
  const s = waitingFor ? { ...derived, waitingFor } : derived;
  return (
    <Alert color={s.needsAction ? "red" : "blue"} variant="light" p="xs"
      title={<Group gap={6}><Text size="sm" fw={600}>Now in {stage}:</Text><Text size="sm">{s.waitingFor}</Text></Group>}>
      {s.needsAction && <Text size="sm" mb={4}>{s.needsAction}</Text>}
      <Anchor size="xs" onClick={() => onOpen(stage)}>Show stage details</Anchor>
    </Alert>
  );
}

export function StageDrawer({ d, checks, stage, onClose, onOpenRun }: {
  d: WorkItemDetail; checks: CheckRun[]; stage: string | null; onClose: () => void; onOpenRun: (run: string) => void;
}) {
  const s: StageState | null = stage ? deriveStageState(d, checks, stage) : null;
  return (
    <Drawer opened={!!s} onClose={onClose} position="right" size="lg" title={s && <Title order={4}>Stage {s.name}</Title>}>
      {s && (
        <Stack gap="md">
          <Group gap="xs">
            <Badge color={s.status === "active" ? "blue" : s.status === "done" ? "teal" : "gray"}>{s.status}</Badge>
            {s.round !== undefined && <Badge variant="outline">round {s.round}</Badge>}
            {s.gate && <Badge variant="outline">gate: {s.gate}</Badge>}
          </Group>
          {s.waitingFor && <Alert color={s.needsAction ? "red" : "blue"} variant="light" title="Waiting for">
            <Text size="sm">{s.waitingFor}</Text>
            {s.needsAction && <Text size="sm" mt={6} fw={500}>{s.needsAction}</Text>}
          </Alert>}

          <div>
            <Text fw={600} size="sm" mb={4}>Steps</Text>
            {s.steps.length ? (
              <Table withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {s.steps.map((step) => (
                    <Table.Tr key={step.name}>
                      <Table.Td><Text size="sm">{step.name}</Text><Text size="xs" c="dimmed">{step.agent}</Text></Table.Td>
                      <Table.Td>{step.run ? <PhaseBadge phase={step.state} size="xs" /> : <Badge size="xs" variant="outline" color="gray">not started</Badge>}</Table.Td>
                      <Table.Td><Text size="xs">{step.detail}</Text>
                        {step.run && <Anchor size="xs" onClick={() => onOpenRun(step.run!.metadata.name)}>Open run</Anchor>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            ) : <Text size="sm" c="dimmed">No agent steps; this stage only has a gate.</Text>}
          </div>

          {!!s.checks.length && (
            <div>
              <Text fw={600} size="sm" mb={4}>Checks</Text>
              <Table withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {s.checks.map((c) => (
                    <Table.Tr key={c.metadata.name}>
                      <Table.Td><Text size="sm">{c.spec.check}</Text>
                        <Text size="xs" c="dimmed">{c.spec.workflow?.purpose}{c.spec.scope ? ` · ${c.spec.scope.mode}${c.spec.scope.mode === "full" ? "" : `: ${c.spec.scope.modules.length} module(s)`}` : ""}</Text></Table.Td>
                      <Table.Td><PhaseBadge phase={c.status?.outcome ?? c.status?.phase ?? "Pending"} size="xs" /></Table.Td>
                      <Table.Td><Text size="xs">{c.status?.durationMs != null ? duration(c.status.durationMs) : c.status?.startedAt ? `running since ${new Date(c.status.startedAt).toLocaleTimeString()}` : "queued"}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}

          {!!s.publication.length && (
            <div>
              <Text fw={600} size="sm" mb={4}>Publication</Text>
              <Stack gap={6}>
                {s.publication.map((p) => (
                  <Group key={p.repository} gap="xs" align="flex-start" wrap="nowrap">
                    <Badge size="xs" color={PUBLICATION_COLOR[p.state] ?? "gray"}>{p.state === "not-configured" ? "not configured" : p.state}</Badge>
                    <Text size="xs"><b>{p.repository}</b>: {p.url ? <Anchor href={p.url} target="_blank" size="xs">{p.detail}</Anchor> : p.detail}</Text>
                  </Group>
                ))}
              </Stack>
            </div>
          )}

          {!!s.humanInput.length && (
            <div>
              <Text fw={600} size="sm" mb={4}>Human input</Text>
              <Stack gap={6}>
                {s.humanInput.map((h) => (
                  <Group key={h.name} gap="xs" align="flex-start" wrap="nowrap">
                    <Badge size="xs" color={HUMAN_COLOR[h.state] ?? "gray"}>{h.kind} · {h.state}</Badge>
                    {h.detail && <Text size="xs" lineClamp={3}>{h.detail}</Text>}
                  </Group>
                ))}
              </Stack>
            </div>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

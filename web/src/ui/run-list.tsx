"use client";
import { Accordion, Badge, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconRepeat } from "@tabler/icons-react";
import type { AgentRun } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import { PhaseBadge } from "./badges.tsx";

const roundOf = (r: AgentRun) => Number(/-r(\d+)(?:-replay-\d+)?$/.exec(r.metadata.name)?.[1] ?? 0);

export function duration(r: AgentRun): string {
  const s = r.status?.startedAt ? Date.parse(r.status.startedAt) : NaN;
  const e = r.status?.finishedAt ? Date.parse(r.status.finishedAt) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return "";
  const sec = (e - s) / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

const OUTCOME_COLOR: Record<string, string> = { accept: "teal", approve: "teal", "needs-info": "orange", "changes-requested": "orange", reject: "red", duplicate: "gray" };

function RunRow({ r, onOpen, nested = false }: { r: AgentRun; onOpen: (n: string) => void; nested?: boolean }) {
  const p = r.status?.provenance;
  return (
    <UnstyledButton onClick={() => onOpen(r.metadata.name)} className="sf-run-row" style={{ paddingLeft: nested ? 28 : 8 }}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          {nested ? <IconRepeat size={14} color="var(--mantine-color-grape-6)" /> : <PhaseBadge phase={r.status?.phase} size="xs" />}
          <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
            {r.spec.agentRef.name}
          </Text>
          <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {r.spec.step}
          </Text>
          {r.status?.result?.outcome && (
            <Badge size="xs" variant="light" color={OUTCOME_COLOR[r.status.result.outcome] ?? "gray"}>
              {r.status.result.outcome}
            </Badge>
          )}
          {r.status?.result?.summary && (
            <Tooltip label={r.status.result.summary} multiline w={420} openDelay={300}>
              <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
                {r.status.result.summary}
              </Text>
            </Tooltip>
          )}
          {!r.status?.result?.summary && r.status?.message && (
            <Text size="xs" c="red" truncate>
              {r.status.message}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          {p?.executor && (
            <Badge size="xs" variant="outline" color="gray">
              {p.executor}
              {p.model?.name ? ` · ${p.model.name}` : ""}
            </Badge>
          )}
          <Text size="xs" c="dimmed" w={48} ta="right">
            {duration(r)}
          </Text>
          <IconChevronRight size={14} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}

/** One-line summary of a stage's latest round, visible while the stage is collapsed. */
function LatestPreview({ runs }: { runs: AgentRun[] }) {
  const last = runs.at(-1);
  if (!last) return null;
  const outcome = runs.map((r) => r.status?.result?.outcome).filter(Boolean).at(-1);
  return (
    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }} visibleFrom="md">
      <Text size="xs" fw={500} style={{ whiteSpace: "nowrap" }}>
        {[...new Set(runs.map((r) => r.spec.agentRef.name))].join(", ")}
      </Text>
      {outcome && (
        <Badge size="xs" variant="light" color={OUTCOME_COLOR[outcome] ?? "gray"} style={{ flexShrink: 0 }}>
          {outcome}
        </Badge>
      )}
      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
        {last.status?.result?.summary ?? ""}
      </Text>
    </Group>
  );
}

/** Rows of one round; replays nest under their original. */
function RoundRows({ runs, all, onOpen }: { runs: AgentRun[]; all: AgentRun[]; onOpen: (n: string) => void }) {
  return (
    <Stack gap={2}>
      {runs.map((r) => (
        <Stack key={r.metadata.name} gap={2}>
          <RunRow r={r} onOpen={onOpen} />
          {all
            .filter((x) => x.spec.replayOf?.name === r.metadata.name || x.spec.parentRunRef?.name === r.metadata.name)
            .map((x) => (
              <RunRow key={x.metadata.name} r={x} onOpen={onOpen} nested />
            ))}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * X3: runs grouped by stage (workflow order) → rounds. The latest round of each stage is shown; earlier rounds
 * (superseded by a re-entry, e.g. after a clarification or a review loop) are collapsed.
 */
export function RunList({ d, onOpen }: { d: WorkItemDetail; onOpen: (n: string) => void }) {
  const primary = d.runs.filter((r) => !r.spec.replayOf && !r.spec.parentRunRef);
  if (!primary.length) return <Text c="dimmed" size="sm">No runs yet.</Text>;
  const order = d.stages.map((s) => s.name);
  const stages = [...new Set(primary.map((r) => r.spec.stage))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const current = d.workItem.status?.stage;

  return (
    <Accordion multiple defaultValue={current && stages.includes(current) ? [current] : stages.slice(-1)} variant="separated" chevronPosition="left">
      {stages.map((stage) => {
        const runs = primary.filter((r) => r.spec.stage === stage);
        const rounds = [...new Set(runs.map(roundOf))].sort((a, b) => b - a);
        const [latest, ...earlier] = rounds;
        const meta = d.stages.find((s) => s.name === stage);
        const failed = runs.some((r) => r.status?.phase === "Failed");
        const running = runs.some((r) => r.status?.phase === "Running" || r.status?.phase === "Pending");
        return (
          <Accordion.Item key={stage} value={stage}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" pr="sm" gap="md">
                <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Text size="sm" fw={600}>
                    {stage}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {meta?.lifecyclePhase}
                  </Text>
                  {stage === current && (
                    <Badge size="xs" variant="filled">
                      current
                    </Badge>
                  )}
                </Group>
                <LatestPreview runs={runs.filter((r) => roundOf(r) === latest)} />
                <Group gap={6} wrap="nowrap">
                  {failed && <PhaseBadge phase="Failed" size="xs" />}
                  {running && <PhaseBadge phase="Running" size="xs" />}
                  <Text size="xs" c="dimmed">
                    {runs.length} run{runs.length === 1 ? "" : "s"}
                    {rounds.length > 1 ? ` · ${rounds.length} rounds` : ""}
                  </Text>
                </Group>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                <RoundRows runs={runs.filter((r) => roundOf(r) === latest)} all={d.runs} onOpen={onOpen} />
                {earlier.length > 0 && (
                  <Accordion variant="default" chevronPosition="left">
                    <Accordion.Item value="earlier" style={{ borderBottom: "none" }}>
                      <Accordion.Control py={0}>
                        <Text size="xs" c="dimmed">
                          {earlier.length} earlier round{earlier.length === 1 ? "" : "s"} (superseded)
                        </Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="sm">
                          {earlier.map((n) => (
                            <Stack key={n} gap={2} style={{ opacity: 0.75 }}>
                              <Text size="xs" c="dimmed" fw={600}>
                                Round {n}
                              </Text>
                              <RoundRows runs={runs.filter((r) => roundOf(r) === n)} all={d.runs} onOpen={onOpen} />
                            </Stack>
                          ))}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}

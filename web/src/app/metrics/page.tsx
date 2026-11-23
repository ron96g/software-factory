"use client";
import { BarChart, DonutChart } from "@mantine/charts";
import { Alert, Badge, Card, Center, Group, SimpleGrid, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { IconChartBar, IconInfoCircle } from "@tabler/icons-react";
import type { FactoryMetrics } from "@/core/ports/metrics.ts";
import { useLive } from "@/ui/api.ts";
import { timeAgo } from "@/ui/badges.tsx";

const ms = (n?: number) => (n === undefined ? "—" : n < 1000 ? `${n} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : `${(n / 60_000).toFixed(1)} m`);
const n = (v?: number) => (v === undefined ? "—" : v.toLocaleString());
const usd = (v?: number, estimated?: boolean) => (v === undefined ? "—" : `$${v.toFixed(4)}${estimated ? " est." : ""}`);
const tokens = (t?: { total: number }) => (t ? n(t.total) : "—");

/** Explanations shown on hover next to each metric (ADR-0082). */
const HELP = {
  runs: "Agent runs recorded (one run = one agent step). Filtered by ?since=&limit= on the API.",
  items: "Work items in the store.",
  agentMs: "Total recorded model-call latency — time the model spends thinking. Only recorded latencies are summed; a run that recorded none is not counted (so the total can be partial).",
  toolMs: "Total recorded tool-call latency — time a tool (shell, file edit, check…) is running, as opposed to the model.",
  tokens: "Provider-reported prompt (input) + completion (output) tokens. Missing where the provider did not report usage — shown as “—” rather than 0.",
  cost: "Provider-reported spend (e.g. the OpenCode runtime), or an estimate from the configured price schedule. Omitted when neither is available; never guessed.",
  tools: "Calls per tool, counted from run transcripts (tool-call messages).",
  timeByAgent: "Per agent: recorded model-call latency (“in agent”) vs tool-call latency (“in tools”). A bar is skipped for an agent that recorded no latency.",
  tokenSplit: "Prompt (input) vs completion (output) tokens across all runs.",
  checks: "Check runs by outcome (passed / failed) and their recorded duration.",
  byAgent: "Per agent: runs, recorded in-agent time, recorded in-tools time, provider-reported tokens and cost.",
  byStage: "Workflow stages: number of runs and recorded wall time (startedAt → finishedAt).",
} as const;

/** ADR-0082: factory-wide observability. Unrecorded values are omitted (`null` in charts), never a guessed zero. */
export default function MetricsPage() {
  const { data } = useLive<FactoryMetrics>("/api/metrics?limit=500", (c) => c.kind === "AgentRun" || c.kind === "CheckRun" || c.kind === "WorkItem");
  if (!data) return <Text c="dimmed">Loading metrics…</Text>;

  const stat = (label: string, value: string, hint: string) => (
    <Card withBorder padding="md" radius="md">
      <Group gap={4}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
        <Info text={hint} />
      </Group>
      <Text fz={26} fw={700} mt={4}>{value}</Text>
    </Card>
  );

  const tools = data.byTool.slice(0, 12).map((t) => ({ tool: t.tool, calls: t.calls }));
  const timeByAgent = data.byAgent
    .filter((a) => a.agentMs !== undefined || a.toolMs !== undefined)
    .slice(0, 10)
    .map((a) => ({ agent: a.agent, inAgent: a.agentMs ?? null, inTools: a.toolMs ?? null }));
  const tokenSplit = data.totals.tokens
    ? [
        { name: "prompt", value: data.totals.tokens.prompt, color: "indigo.6" },
        { name: "completion", value: data.totals.tokens.completion, color: "teal.6" },
      ]
    : null;
  const checks = data.checks.map((c) => ({ check: c.check, passed: c.runs - c.failed, failed: c.failed }));

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Metrics</Title>
          <Text size="sm" c="dimmed">Tools, tokens, time in the agent vs in the tools, checks and cost — derived from transcripts and runs.</Text>
        </div>
        <Group gap="xs">
          <Badge variant="light" color="gray" leftSection={<IconChartBar size={12} />}>{data.totals.runs} runs</Badge>
          <Text size="xs" c="dimmed">updated {timeAgo(data.generatedAt)}</Text>
        </Group>
      </Group>

      {!data.pricing && (
        <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
          Cost estimates are unavailable: no price schedule is configured. Provider-reported cost (e.g. from the OpenCode runtime) is still shown.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
        {stat("Runs", n(data.totals.runs), HELP.runs)}
        {stat("Items", n(data.totals.items), HELP.items)}
        {stat("Time in agent", ms(data.totals.agentMs), HELP.agentMs)}
        {stat("Time in tools", ms(data.totals.toolMs), HELP.toolMs)}
        {stat("Tokens", tokens(data.totals.tokens), HELP.tokens)}
        {stat("Cost", usd(data.totals.costUsd, data.totals.costEstimated), HELP.cost)}
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Chart title="Tools used (calls)" hint={HELP.tools} empty={tools.length === 0}>
          <BarChart h={280} data={tools} dataKey="tool" series={[{ name: "calls", color: "indigo.6" }]} barProps={{ radius: 4 }} />
        </Chart>
        <Chart title="Time in agent vs tools" hint={HELP.timeByAgent} empty={timeByAgent.length === 0}>
          <BarChart h={280} data={timeByAgent} dataKey="agent" type="stacked" series={[{ name: "inAgent", label: "In agent", color: "indigo.6" }, { name: "inTools", label: "In tools", color: "teal.6" }]} />
        </Chart>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Chart title="Tokens (prompt vs completion)" hint={HELP.tokenSplit} empty={!tokenSplit}>
          {tokenSplit && (
            <Center h={240}>
              <DonutChart h={240} w={320} data={tokenSplit} size={170} thickness={32} withLabelsLine withLabels />
            </Center>
          )}
        </Chart>
        <Chart title="Checks (passed vs failed)" hint={HELP.checks} empty={checks.length === 0}>
          <BarChart h={240} data={checks} dataKey="check" type="stacked" series={[{ name: "passed", color: "teal.6" }, { name: "failed", color: "red.6" }]} />
        </Chart>
      </SimpleGrid>

      <Section title="By agent" hint={HELP.byAgent}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Agent</Table.Th>
              <Table.Th>Runs</Table.Th>
              <Table.Th><Group gap={4} wrap="nowrap">In agent <Info text={HELP.agentMs} /></Group></Table.Th>
              <Table.Th><Group gap={4} wrap="nowrap">In tools <Info text={HELP.toolMs} /></Group></Table.Th>
              <Table.Th><Group gap={4} wrap="nowrap">Tokens <Info text={HELP.tokens} /></Group></Table.Th>
              <Table.Th><Group gap={4} wrap="nowrap">Cost <Info text={HELP.cost} /></Group></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.byAgent.map((a) => (
              <Table.Tr key={a.agent}>
                <Table.Td><Text size="sm" fw={500}>{a.agent}</Text></Table.Td>
                <Table.Td>{n(a.runs)}</Table.Td>
                <Table.Td>{ms(a.agentMs)}</Table.Td>
                <Table.Td>{ms(a.toolMs)}</Table.Td>
                <Table.Td>{tokens(a.tokens)}</Table.Td>
                <Table.Td>{usd(a.costUsd)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Section>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Section title="By stage" hint={HELP.byStage}>
          <Table striped highlightOnHover>
            <Table.Thead><Table.Tr><Table.Th>Stage</Table.Th><Table.Th>Runs</Table.Th><Table.Th>Wall time</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {data.byStage.map((s) => (
                <Table.Tr key={s.stage}><Table.Td><Text size="sm" fw={500}>{s.stage}</Text></Table.Td><Table.Td>{n(s.runs)}</Table.Td><Table.Td>{ms(s.wallMs)}</Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Section>
        <Section title="Checks" hint={HELP.checks}>
          <Table striped highlightOnHover>
            <Table.Thead><Table.Tr><Table.Th>Check</Table.Th><Table.Th>Runs</Table.Th><Table.Th>Failed</Table.Th><Table.Th>Time</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {data.checks.map((c) => (
                <Table.Tr key={c.check}>
                  <Table.Td><Text size="sm" fw={500}>{c.check}</Text></Table.Td>
                  <Table.Td>{n(c.runs)}</Table.Td>
                  <Table.Td>{c.failed ? <Badge size="xs" color="red" variant="light">{c.failed}</Badge> : "0"}</Table.Td>
                  <Table.Td>{ms(c.ms)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Section>
      </SimpleGrid>
    </Stack>
  );
}

/** A small hover affordance that explains a metric (ADR-0082). */
function Info({ text }: { text: string }) {
  return (
    <Tooltip label={text} multiline w={300} withArrow events={{ hover: true, focus: true, touch: true }}>
      <IconInfoCircle size={13} style={{ opacity: 0.5, cursor: "help", flexShrink: 0 }} />
    </Tooltip>
  );
}

function Chart({ title, hint, empty, children }: { title: string; hint: string; empty: boolean; children: React.ReactNode }) {
  return (
    <div>
      <Group gap={4} mb="xs"><Title order={4}>{title}</Title><Info text={hint} /></Group>
      <Card withBorder padding="md" radius="md">
        {empty ? <Text size="sm" c="dimmed">Not enough recorded data yet.</Text> : children}
      </Card>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <Group gap={4} mb="xs"><Title order={4}>{title}</Title><Info text={hint} /></Group>
      <Card withBorder padding={0} radius="md">
        {children}
      </Card>
    </div>
  );
}

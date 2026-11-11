"use client";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  List,
  Stack,
  Tabs,
  Text,
  Textarea,
  Timeline,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconChevronLeft, IconHandStop, IconX } from "@tabler/icons-react";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import type { AgentRun, Approval, Clarification } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import { act, useLive } from "@/ui/api.ts";
import { PhaseBadge, TypeBadge, timeAgo } from "@/ui/badges.tsx";
import { MarkdownView } from "@/ui/markdown.tsx";
import { RunDrawer } from "@/ui/run-inspector.tsx";

const PHASE_COLOR: Record<string, string> = { inception: "nebula", construction: "plasma", operations: "teal", build: "plasma" };

export default function ItemPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { data: d, error } = useLive<WorkItemDetail>(`/api/workitems/${name}`, (n) => n.workItem === name || n.name === name);
  const [openRun, setOpenRun] = useState<string | null>(null);

  if (error) return <Alert color="red" title="Error">{error}</Alert>;
  if (!d) return <Text c="dimmed">Loading…</Text>;
  const wi = d.workItem;
  const st = wi.status;
  const openClar = d.clarifications.find((c) => c.metadata.name === st?.blockedBy?.name && st?.phase === "Blocked");
  const openAppr = d.approvals.find((a) => a.metadata.name === st?.blockedBy?.name && st?.phase === "AwaitingApproval");
  const run = d.runs.find((r) => r.metadata.name === openRun) ?? null;

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Anchor component={Link} href="/" size="sm">
        <Group gap={4}>
          <IconChevronLeft size={14} /> Dashboard
        </Group>
      </Anchor>

      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Title order={2}>{wi.spec.title}</Title>
            <PhaseBadge phase={st?.phase} size="md" />
            <TypeBadge type={st?.classification?.type} />
            {st?.classification?.priority && <Badge variant="outline">{st.classification.priority}</Badge>}
          </Group>
          <Text size="sm" c="dimmed" ff="monospace">
            {wi.metadata.name} · source {wi.spec.sourceRef.name}
            {wi.spec.externalRef?.url && (
              <>
                {" · "}
                <Anchor href={wi.spec.externalRef.url} target="_blank" size="sm">
                  #{wi.spec.externalRef.id}
                </Anchor>
              </>
            )}
            {" · "}workflow {wi.spec.workflowRef?.name} · repos {(wi.spec.repositoryRefs ?? []).map((r) => r.name).join(", ") || "–"}
          </Text>
        </div>
      </Group>

      <StageProgress d={d} />

      {st?.phase === "Failed" && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Failed">
          {st.message}
        </Alert>
      )}
      {openClar && <ClarificationPanel c={openClar} />}
      {openAppr && <ApprovalPanel a={openAppr} />}

      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Card className="sf-glass">
            <Tabs defaultValue="artifacts">
              <Tabs.List>
                <Tabs.Tab value="artifacts">Artifacts ({d.artifacts.length})</Tabs.Tab>
                <Tabs.Tab value="runs">Agent runs ({d.runs.length})</Tabs.Tab>
                <Tabs.Tab value="description">Description</Tabs.Tab>
                <Tabs.Tab value="human">Human input ({d.clarifications.length + d.approvals.length})</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="artifacts" pt="md">
                <Artifacts d={d} />
              </Tabs.Panel>
              <Tabs.Panel value="runs" pt="md">
                <Runs runs={d.runs} onOpen={setOpenRun} />
              </Tabs.Panel>
              <Tabs.Panel value="description" pt="md">
                <MarkdownView>{wi.spec.description || "_No description._"}</MarkdownView>
              </Tabs.Panel>
              <Tabs.Panel value="human" pt="md">
                <HumanHistory clarifications={d.clarifications} approvals={d.approvals} />
              </Tabs.Panel>
            </Tabs>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card className="sf-glass">
            <Title order={5} mb="sm">
              Timeline
            </Title>
            <Timeline bulletSize={14} lineWidth={2}>
              {[...d.events].reverse().slice(0, 60).map((e) => (
                <Timeline.Item
                  key={e.metadata.name}
                  color={e.spec.type === "Warning" ? "red" : "nebula"}
                  title={
                    <Text size="sm" fw={500}>
                      {e.spec.reason} <Text span size="xs" c="dimmed">{e.spec.involvedObject.kind}</Text>
                    </Text>
                  }
                >
                  <Text size="xs" c="dimmed" lineClamp={3}>
                    {e.spec.message}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {timeAgo(e.metadata.creationTimestamp)}
                  </Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </Card>
        </Grid.Col>
      </Grid>

      <RunDrawer run={run} conversations={d.conversations} onClose={() => setOpenRun(null)} />
    </Stack>
  );
}

function StageProgress({ d }: { d: WorkItemDetail }) {
  const st = d.workItem.status;
  const idx = d.stages.findIndex((s) => s.name === st?.stage);
  const done = st?.phase === "Done";
  return (
    <Card className="sf-glass" p="sm">
      <Group gap={6} wrap="wrap">
        {d.stages.map((s, i) => {
          const current = i === idx && !done;
          const passed = done || i < idx;
          const color = PHASE_COLOR[s.lifecyclePhase] ?? "gray";
          return (
            <Tooltip key={s.name} label={`${s.lifecyclePhase}${s.gate ? ` · gate: ${s.gate}` : ""}`}>
              <Badge
                size="lg"
                color={current && st?.phase === "Blocked" ? "orange" : current && st?.phase === "AwaitingApproval" ? "yellow" : color}
                variant={current ? "filled" : passed ? "light" : "outline"}
                leftSection={passed ? <IconCheck size={12} /> : s.gate === "human-approval" ? <IconHandStop size={12} /> : undefined}
                style={{ opacity: passed || current ? 1 : 0.55 }}
              >
                {s.name}
              </Badge>
            </Tooltip>
          );
        })}
      </Group>
    </Card>
  );
}

function ClarificationPanel({ c }: { c: Clarification }) {
  const [answers, setAnswers] = useState<string[]>(c.spec.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  return (
    <Alert color="orange" variant="light" title={`Blocked at ${c.spec.stage}: the agent needs your input`} icon={<IconHandStop />}>
      <Stack gap="sm" mt="xs">
        {c.spec.questions.map((q, i) => (
          <Textarea
            key={i}
            label={q}
            autosize
            minRows={1}
            value={answers[i]}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
            }}
          />
        ))}
        <Group justify="flex-end">
          <Button
            color="orange"
            loading={busy}
            disabled={answers.every((a) => !a.trim())}
            onClick={async () => {
              setBusy(true);
              await act(`/api/clarifications/${c.metadata.name}/answer`, { answers }, "Answer sent. Resuming.");
              setBusy(false);
            }}
          >
            Answer &amp; resume
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

function ApprovalPanel({ a }: { a: Approval }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    await act(`/api/approvals/${a.metadata.name}/decide`, { decision, comment }, decision === "approve" ? "Approved" : "Rejected");
    setBusy(null);
  };
  return (
    <Alert color="yellow" variant="light" title={`Gate: ${a.spec.stage} needs human approval`} icon={<IconHandStop />}>
      <Stack gap="xs" mt="xs">
        {a.spec.approvers.length > 0 && (
          <Text size="sm">
            Approvers: {a.spec.approvers.map((x) => x.role).join(", ")} <Text span size="xs" c="dimmed">(role checks arrive in v0.4)</Text>
          </Text>
        )}
        {a.spec.criteria?.length ? (
          <List size="sm">
            {a.spec.criteria.map((c) => (
              <List.Item key={c}>{c}</List.Item>
            ))}
          </List>
        ) : null}
        <Textarea placeholder="Comment (optional)" autosize value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" color="red" leftSection={<IconX size={14} />} loading={busy === "reject"} onClick={() => decide("reject")}>
            Reject
          </Button>
          <Button color="teal" leftSection={<IconCheck size={14} />} loading={busy === "approve"} onClick={() => decide("approve")}>
            Approve
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

function Artifacts({ d }: { d: WorkItemDetail }) {
  const sorted = useMemo(() => [...d.artifacts].reverse(), [d.artifacts]);
  if (!sorted.length) return <Text c="dimmed" size="sm">No artifacts yet.</Text>;
  return (
    // Re-key on count so the newest artifact opens when new ones arrive.
    <Accordion key={sorted.length} variant="separated" defaultValue={sorted[0]?.metadata.name}>
      {sorted.map((a) => (
        <Accordion.Item key={a.metadata.name} value={a.metadata.name}>
          <Accordion.Control>
            <Group gap="xs">
              <Badge variant="light">{a.spec.artifactTypeRef.name}</Badge>
              <Text size="sm">by {a.spec.producedBy?.agentRef.name}</Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {a.spec.producedBy?.agentRunRef.name}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <MarkdownView>{a.spec.content}</MarkdownView>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

/** Runs grouped as a tree via parentRunRef (delegation, ADR-0012). */
function Runs({ runs, onOpen }: { runs: AgentRun[]; onOpen: (n: string) => void }) {
  const roots = runs.filter((r) => !r.spec.parentRunRef);
  const children = (n: string) => runs.filter((r) => r.spec.parentRunRef?.name === n);
  const Row = ({ r, depth }: { r: AgentRun; depth: number }) => (
    <>
      <Group justify="space-between" className="sf-row" p="xs" pl={8 + depth * 24} onClick={() => onOpen(r.metadata.name)} style={{ borderRadius: 8 }}>
        <Group gap="sm">
          <PhaseBadge phase={r.status?.phase} size="xs" />
          <Text size="sm" fw={500}>
            {r.spec.agentRef.name}
          </Text>
          <Text size="sm" c="dimmed">
            {r.spec.stage} / {r.spec.step}
          </Text>
          <Tooltip label="round: increments each time a stage is (re-)entered">
            <Badge size="xs" variant="light" color="gray">
              {/-r(\d+)$/.exec(r.metadata.name)?.[0].slice(1) ?? ""}
            </Badge>
          </Tooltip>
          {r.status?.result?.outcome && (
            <Badge size="xs" variant="light" color={r.status.result.outcome === "accept" ? "teal" : "orange"}>
              {r.status.result.outcome}
            </Badge>
          )}
          <Badge size="xs" variant="outline">
            {r.status?.provenance?.executor ?? r.status?.executor ?? "…"}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed" lineClamp={1} maw={420}>
          {r.status?.result?.summary ?? r.status?.message ?? ""}
        </Text>
      </Group>
      {children(r.metadata.name).map((c) => (
        <Row key={c.metadata.name} r={c} depth={depth + 1} />
      ))}
    </>
  );
  if (!runs.length) return <Text c="dimmed" size="sm">No runs yet.</Text>;
  return (
    <Stack gap={2}>
      {[...roots].reverse().map((r) => (
        <Row key={r.metadata.name} r={r} depth={0} />
      ))}
      <Text size="xs" c="dimmed" mt="xs">
        Click a run to inspect its transcript and provenance, or to ask the agent why it did something.
      </Text>
    </Stack>
  );
}

function HumanHistory({ clarifications, approvals }: { clarifications: Clarification[]; approvals: Approval[] }) {
  if (!clarifications.length && !approvals.length) return <Text c="dimmed" size="sm">No human input yet.</Text>;
  return (
    <Stack>
      {clarifications.map((c) => (
        <Card key={c.metadata.name} withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Clarification · {c.spec.stage}
            </Text>
            <Badge color={c.spec.answers?.length ? "teal" : "orange"}>{c.spec.answers?.length ? "answered" : "open"}</Badge>
          </Group>
          {c.spec.questions.map((q, i) => (
            <Text key={i} size="sm" mt={4}>
              <b>Q:</b> {q}
              {c.spec.answers?.[i] && (
                <>
                  <br />
                  <b>A:</b> {c.spec.answers[i]} <Text span size="xs" c="dimmed">({c.spec.answeredBy})</Text>
                </>
              )}
            </Text>
          ))}
        </Card>
      ))}
      {approvals.map((a) => (
        <Card key={a.metadata.name} withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Approval · {a.spec.stage}
            </Text>
            <Badge color={a.spec.decision === "approve" ? "teal" : a.spec.decision === "reject" ? "red" : "yellow"}>{a.spec.decision ?? "pending"}</Badge>
          </Group>
          {a.spec.comment && <Text size="sm">{a.spec.comment}</Text>}
          {a.spec.decidedBy && (
            <Text size="xs" c="dimmed">
              by {a.spec.decidedBy}
            </Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}

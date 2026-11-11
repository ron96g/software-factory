"use client";
import { Accordion, Badge, Box, Button, Code, Divider, Drawer, Group, Paper, ScrollArea, SimpleGrid, Stack, Text, Textarea, ThemeIcon, Tooltip } from "@mantine/core";
import { IconArrowsDiff, IconMessageQuestion, IconNote, IconRefresh, IconRobot, IconSend, IconSettings, IconTool, IconUser } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { AgentRun, Artifact, Conversation } from "@/core/model/kinds.ts";
import type { TranscriptMessage } from "@/core/ports/transcripts.ts";
import { act, api, useLive } from "./api.ts";
import { PhaseBadge } from "./badges.tsx";
import { MarkdownView } from "./markdown.tsx";

const ROLE_ICON: Record<string, React.ReactNode> = {
  system: <IconSettings size={14} />,
  user: <IconUser size={14} />,
  assistant: <IconRobot size={14} />,
  "tool-call": <IconTool size={14} />,
  "tool-result": <IconTool size={14} />,
  note: <IconNote size={14} />,
};
const ROLE_COLOR: Record<string, string> = { system: "gray", user: "blue", assistant: "indigo", "tool-call": "yellow", "tool-result": "yellow", note: "gray" };

export function TranscriptMessages({ messages, collapseLong = true }: { messages: TranscriptMessage[]; collapseLong?: boolean }) {
  return (
    <Stack gap="xs">
      {messages.map((m) => {
        const long = collapseLong && (m.role === "system" || m.role === "user" || m.role === "tool-result") && m.content.length > 600;
        return (
          <Paper key={m.seq} p="xs" className="sf-surface">
            <Group gap="xs" mb={4}>
              <ThemeIcon size="sm" variant="light" color={ROLE_COLOR[m.role]}>
                {ROLE_ICON[m.role]}
              </ThemeIcon>
              <Text size="xs" fw={600}>
                {m.role}
              </Text>
              <Text size="xs" c="dimmed">
                {m.author.type}:{m.author.id} · #{m.seq} · {new Date(m.at).toLocaleTimeString()}
              </Text>
              {m.meta?.tool && <Badge size="xs" variant="outline">{String(m.meta.tool)}</Badge>}
              {typeof m.meta?.latencyMs === "number" && <Badge size="xs" variant="light">{m.meta.latencyMs} ms</Badge>}
              {typeof m.meta?.model === "string" && <Badge size="xs" variant="light" color="blue">{m.meta.model}</Badge>}
            </Group>
            {long ? (
              <Accordion variant="contained" chevronPosition="left">
                <Accordion.Item value="c">
                  <Accordion.Control>
                    <Text size="xs" c="dimmed">
                      {m.content.slice(0, 140).replace(/\s+/g, " ")}… ({m.content.length} chars)
                    </Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <div className="sf-transcript-msg">{m.content}</div>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            ) : m.role === "assistant" && m.author.type === "agent" && !m.content.trim().startsWith("{") ? (
              <MarkdownView>{m.content}</MarkdownView>
            ) : (
              <div className="sf-transcript-msg">{m.content}</div>
            )}
          </Paper>
        );
      })}
      {messages.length === 0 && <Text c="dimmed" size="sm">No messages recorded.</Text>}
    </Stack>
  );
}

/** Run inspector: provenance + recorded transcript (replay "inspect" mode) + "Ask this agent" chat. */
export function RunDrawer({
  run,
  original,
  artifacts,
  conversations,
  onClose,
  onOpen,
}: {
  run: AgentRun | null;
  original: AgentRun | null;
  artifacts: Artifact[];
  conversations: Conversation[];
  onClose: () => void;
  onOpen: (name: string) => void;
}) {
  const [tab, setTab] = useState<"transcript" | "chat" | "compare">("transcript");
  const { data: transcript } = useLive<TranscriptMessage[]>(run ? `/api/runs/${run.metadata.name}/transcript` : null, (n) => n.name === run?.metadata.name);
  useEffect(() => setTab(run?.spec.replayOf ? "compare" : "transcript"), [run?.metadata.name, run?.spec.replayOf]);
  if (!run) return null;
  const p = run.status?.provenance;
  return (
    <Drawer opened={!!run} onClose={onClose} position="right" size="xl" title={<Text fw={600}>{run.spec.agentRef.name} · {run.spec.stage}/{run.spec.step}</Text>}>
      <Stack>
        <Group gap="xs">
          <PhaseBadge phase={run.status?.phase} />
          <Badge variant="light">executor: {p?.executor ?? run.status?.executor ?? "–"}</Badge>
          {p?.model && <Badge variant="light" color="blue">{p.model.provider}/{p.model.name} ({p.model.tier})</Badge>}
          {p?.promptHash && <Tooltip label="prompt hash"><Badge variant="outline">#{p.promptHash}</Badge></Tooltip>}
        </Group>
        {run.status?.result?.summary && <Text size="sm">{run.status.result.summary}</Text>}
        {run.status?.message && <Text size="sm" c="red">{run.status.message}</Text>}
        {p && (
          <Accordion variant="contained">
            <Accordion.Item value="prov">
              <Accordion.Control>Provenance</Accordion.Control>
              <Accordion.Panel>
                <Code block>{JSON.stringify(p, null, 2)}</Code>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        )}
        {run.spec.replayOf && (
          <Text size="sm" c="dimmed">
            Replay of{" "}
            <Text span ff="monospace" size="sm" c="indigo" style={{ cursor: "pointer" }} onClick={() => onOpen(run.spec.replayOf!.name)}>
              {run.spec.replayOf.name}
            </Text>
            . It used the same inputs and answers, and doesn&apos;t change the work item.
          </Text>
        )}
        <Group>
          <Button size="xs" variant={tab === "transcript" ? "filled" : "default"} onClick={() => setTab("transcript")}>
            Transcript
          </Button>
          {original && (
            <Button size="xs" leftSection={<IconArrowsDiff size={14} />} variant={tab === "compare" ? "filled" : "default"} onClick={() => setTab("compare")}>
              Compare
            </Button>
          )}
          <Button
            size="xs"
            leftSection={<IconMessageQuestion size={14} />}
            variant={tab === "chat" ? "filled" : "default"}
            disabled={run.status?.phase !== "Succeeded" && run.status?.phase !== "Failed"}
            onClick={() => setTab("chat")}
          >
            Ask this agent
          </Button>
          {!run.spec.replayOf && (run.status?.phase === "Succeeded" || run.status?.phase === "Failed") && (
            <Tooltip label="Run again with the same inputs and answers (e.g. after changing the agent, skill or model). The work item is not changed.">
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                onClick={async () => {
                  const r = await act<AgentRun>(`/api/runs/${run.metadata.name}/rerun`, {}, "Re-run started");
                  if (r) onOpen(r.metadata.name);
                }}
              >
                Re-run
              </Button>
            </Tooltip>
          )}
        </Group>
        <Divider />
        {tab === "compare" && original ? (
          <Compare original={original} replay={run} artifacts={artifacts} />
        ) : tab === "transcript" ? (
          <TranscriptMessages messages={transcript ?? []} />
        ) : (
          <ExplainChat run={run} existing={conversations.filter((c) => c.spec.agentRunRef.name === run.metadata.name)} />
        )}
      </Stack>
    </Drawer>
  );
}

function ExplainChat({ run, existing }: { run: AgentRun; existing: Conversation[] }) {
  const [conv, setConv] = useState<string | null>(existing.at(-1)?.metadata.name ?? null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (conv) void api<TranscriptMessage[]>(`/api/conversations/${conv}/messages`).then(setMessages);
  }, [conv]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    let name = conv;
    if (!name) {
      const c = await act<Conversation>("/api/conversations", { runName: run.metadata.name });
      name = c?.metadata.name ?? null;
      setConv(name);
    }
    if (name) {
      const q = text;
      setText("");
      setMessages((m) => [...m, { seq: -1, at: new Date().toISOString(), role: "user", author: { type: "human", id: "you" }, content: q }]);
      await act(`/api/conversations/${name}/messages`, { text: q });
      setMessages(await api<TranscriptMessage[]>(`/api/conversations/${name}/messages`));
    }
    setBusy(false);
  }

  return (
    <Stack>
      <Text size="xs" c="dimmed">
        Explain mode (ADR-0012): the agent answers using its recorded transcript and provenance. It can&apos;t change anything.
      </Text>
      <ScrollArea.Autosize mah={480}>
        <TranscriptMessages messages={messages} collapseLong={false} />
      </ScrollArea.Autosize>
      <Box>
        <Textarea
          placeholder={`Ask ${run.spec.agentRef.name} why it did something…`}
          autosize
          minRows={2}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <Group justify="flex-end" mt="xs">
          <Button size="xs" leftSection={<IconSend size={14} />} loading={busy} onClick={() => void send()}>
            Ask (Ctrl+Enter)
          </Button>
        </Group>
      </Box>
    </Stack>
  );
}

function RunSummary({ run, artifacts }: { run: AgentRun; artifacts: Artifact[] }) {
  const r = run.status?.result;
  const p = run.status?.provenance;
  const own = artifacts.filter((a) => a.spec.producedBy?.agentRunRef.name === run.metadata.name);
  return (
    <Stack gap="xs">
      <Group gap={6}>
        <PhaseBadge phase={run.status?.phase} size="xs" />
        <Badge size="xs" variant="light">{p?.executor ?? "…"}</Badge>
        {p?.model && <Badge size="xs" variant="light" color="blue">{p.model.name}</Badge>}
        {p?.promptHash && <Badge size="xs" variant="outline">#{p.promptHash}</Badge>}
      </Group>
      <Text size="sm">{r?.summary ?? "–"}</Text>
      {r?.outcome && <Text size="sm"><b>Outcome:</b> {r.outcome}</Text>}
      {r?.questions?.length ? (
        <Text size="sm"><b>Questions:</b> {r.questions.join(" · ")}</Text>
      ) : null}
      {r?.classification && <Code block>{JSON.stringify(r.classification, null, 2)}</Code>}
      {own.map((a) => (
        <Paper key={a.metadata.name} p="xs">
          <Badge size="xs" variant="light" mb={4}>{a.spec.artifactTypeRef.name}</Badge>
          <ScrollArea.Autosize mah={320}>
            <MarkdownView>{a.spec.content}</MarkdownView>
          </ScrollArea.Autosize>
        </Paper>
      ))}
    </Stack>
  );
}

/** Side-by-side comparison of an original run and its replay (ADR-0012, re-run mode). */
function Compare({ original, replay, artifacts }: { original: AgentRun; replay: AgentRun; artifacts: Artifact[] }) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const o = original.status?.result;
  const r = replay.status?.result;
  const diffs = [
    !same(o?.outcome, r?.outcome) && "outcome",
    !same(o?.questions, r?.questions) && "questions",
    !same(o?.classification, r?.classification) && "classification",
    !same(original.status?.provenance?.promptHash, replay.status?.provenance?.promptHash) && "prompt",
    !same(original.status?.provenance?.definitions, replay.status?.provenance?.definitions) && "definitions",
  ].filter(Boolean);
  return (
    <Stack>
      <Text size="sm" c={diffs.length ? "orange" : "teal"}>
        {replay.status?.phase !== "Succeeded" ? "Replay still running…" : diffs.length ? `Differs in: ${diffs.join(", ")}` : "Same result as the original."}
      </Text>
      <SimpleGrid cols={2}>
        <div>
          <Text size="xs" c="dimmed" mb={4}>Original · {original.metadata.name}</Text>
          <RunSummary run={original} artifacts={artifacts} />
        </div>
        <div>
          <Text size="xs" c="dimmed" mb={4}>Replay · {replay.metadata.name}</Text>
          <RunSummary run={replay} artifacts={artifacts} />
        </div>
      </SimpleGrid>
    </Stack>
  );
}

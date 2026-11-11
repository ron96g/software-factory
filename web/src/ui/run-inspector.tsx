"use client";
import { Accordion, Badge, Box, Button, Code, Divider, Drawer, Group, Paper, ScrollArea, Stack, Text, Textarea, ThemeIcon, Tooltip } from "@mantine/core";
import { IconMessageQuestion, IconRobot, IconSend, IconTool, IconUser, IconSettings, IconNote } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { AgentRun, Conversation } from "@/core/model/kinds.ts";
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
const ROLE_COLOR: Record<string, string> = { system: "gray", user: "plasma", assistant: "nebula", "tool-call": "yellow", "tool-result": "yellow", note: "gray" };

export function TranscriptMessages({ messages, collapseLong = true }: { messages: TranscriptMessage[]; collapseLong?: boolean }) {
  return (
    <Stack gap="xs">
      {messages.map((m) => {
        const long = collapseLong && (m.role === "system" || m.role === "user" || m.role === "tool-result") && m.content.length > 600;
        return (
          <Paper key={m.seq} p="xs" className="sf-glass">
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
              {typeof m.meta?.model === "string" && <Badge size="xs" variant="light" color="plasma">{m.meta.model}</Badge>}
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
export function RunDrawer({ run, conversations, onClose }: { run: AgentRun | null; conversations: Conversation[]; onClose: () => void }) {
  const [tab, setTab] = useState<"transcript" | "chat">("transcript");
  const { data: transcript } = useLive<TranscriptMessage[]>(run ? `/api/runs/${run.metadata.name}/transcript` : null, (n) => n.name === run?.metadata.name);
  useEffect(() => setTab("transcript"), [run?.metadata.name]);
  if (!run) return null;
  const p = run.status?.provenance;
  return (
    <Drawer opened={!!run} onClose={onClose} position="right" size="xl" title={<Text fw={600}>{run.spec.agentRef.name} · {run.spec.stage}/{run.spec.step}</Text>}>
      <Stack>
        <Group gap="xs">
          <PhaseBadge phase={run.status?.phase} />
          <Badge variant="light">executor: {p?.executor ?? run.status?.executor ?? "–"}</Badge>
          {p?.model && <Badge variant="light" color="plasma">{p.model.provider}/{p.model.name} ({p.model.tier})</Badge>}
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
        <Group>
          <Button size="xs" variant={tab === "transcript" ? "filled" : "default"} onClick={() => setTab("transcript")}>
            Transcript
          </Button>
          <Button
            size="xs"
            leftSection={<IconMessageQuestion size={14} />}
            variant={tab === "chat" ? "filled" : "default"}
            disabled={run.status?.phase !== "Succeeded" && run.status?.phase !== "Failed"}
            onClick={() => setTab("chat")}
          >
            Ask this agent
          </Button>
        </Group>
        <Divider />
        {tab === "transcript" ? (
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

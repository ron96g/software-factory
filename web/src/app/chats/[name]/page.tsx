"use client";
import { Accordion, Alert, Anchor, Badge, Button, Card, Code, Group, Loader, Modal, MultiSelect, Select, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { AgentChatDetail } from "@/core/ports/agent-chat.ts";
import type { NewItemOptions } from "@/core/ports/app.ts";
import { act, useLive } from "@/ui/api.ts";
import { MarkdownView } from "@/ui/markdown.tsx";

export default function ChatPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { data, error, reload } = useLive<AgentChatDetail>(`/api/chats/${name}`, (n) => n.kind === "Conversation" && n.name === name);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const request = useRef<{ id: string; text: string } | null>(null);
  const c = data?.conversation;
  const failed = c?.status?.phase === "Failed" && c.status.activeTurn === c.spec.turn?.id;
  const pending = !!c?.spec.turn && c.status?.completedTurn !== c.spec.turn.id && !failed;
  const phase = c?.spec.turn && c.status?.activeTurn !== c.spec.turn.id ? "Queued" : c?.status?.phase || "Ready";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), 1500);
    return () => clearInterval(timer);
  }, [pending, reload]);
  if (!data || !c) return <Text c={error ? "red" : "dimmed"}>{error || "Loading..."}</Text>;
  const messages = data.messages.filter((m) => m.role === "user" || (m.role === "assistant" && m.meta?.final === true));
  const activity = data.messages.filter((m) => m.role !== "user" && !(m.role === "assistant" && m.meta?.final === true));
  const submit = async (value: string) => {
    if (sending || pending || !value.trim()) return;
    setSending(true);
    if (request.current?.text !== value) request.current = { id: crypto.randomUUID(), text: value };
    const accepted = await act(`/api/chats/${name}/turns`, request.current);
    setSending(false);
    if (accepted) { request.current = null; setText(""); await reload(); }
  };
  return (
    <Stack gap="lg" maw={1100} mx="auto">
      <Anchor component={Link} href="/chats" size="sm">Back to chats</Anchor>
      <Group justify="space-between">
        <div><Title order={2}>{c.spec.title}</Title><Text c="dimmed" size="sm">{c.spec.agentRef?.name} - read-only investigation</Text></div>
        <Group><Badge variant="light">{phase}</Badge>{c.spec.workItemRef
          ? <Button component={Link} href={`/items/${c.spec.workItemRef.name}`} variant="light">Open work item</Button>
          : <Button variant="light" disabled={pending || !messages.some((m) => m.role === "assistant")} onClick={() => setHandoff(true)}>Create work item</Button>}</Group>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      <Alert color="blue">
        {c.spec.workItemRef && <Text size="sm" mb="xs">Work item context: <Anchor component={Link} href={`/items/${c.spec.workItemRef.name}`}>{c.spec.workItemRef.name}</Anchor>. Evidence is refreshed before each turn and recorded in the execution log; chatting does not change the item.</Text>}
        No shell, repository workspace, writes or gate decisions. Cluster observations may become stale. Review findings before handing them to a workflow.
      </Alert>
      {messages.length === 0 && <Text c="dimmed">Describe the issue, namespace and affected resources. The agent can discover supported CRs and investigate their current state.</Text>}
      {messages.map((m) => (
        <Card className="sf-surface" key={m.seq}><Text size="xs" c="dimmed" mb="xs">{m.author.id} - {new Date(m.at).toLocaleString()}</Text><MarkdownView>{m.content}</MarkdownView></Card>
      ))}
      {c.spec.turn && !data.messages.some((m) => m.role === "user" && m.meta?.turnId === c.spec.turn?.id) && <Card className="sf-surface"><Text size="xs" c="dimmed">Queued message</Text><MarkdownView>{c.spec.turn.text}</MarkdownView></Card>}
      {pending && <Group><Loader size="sm" /><Text size="sm">{phase}{c.status?.message ? `: ${c.status.message}` : ": the agent is investigating."}{c.status?.retryAt && ` Next attempt: ${new Date(c.status.retryAt).toLocaleString()}`}</Text></Group>}
      {failed && <Alert color="red" title="Chat turn failed"><Text>{c.status?.message}</Text><Button mt="sm" variant="light" disabled={sending} onClick={() => void submit(c.spec.turn!.text)}>Retry question</Button></Alert>}
      {activity.length > 0 && <Accordion variant="contained"><Accordion.Item value="activity"><Accordion.Control>Tool activity and execution log ({activity.length})</Accordion.Control><Accordion.Panel><Stack mah={450} style={{ overflowY: "auto" }}>{activity.map((m) => (
        <div key={m.seq}><Text size="xs" fw={600}>{m.role}{m.meta?.tool ? `: ${m.meta.tool}` : ""} - {new Date(m.at).toLocaleTimeString()}</Text><Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.content || "(tool request)"}</Code></div>
      ))}</Stack></Accordion.Panel></Accordion.Item></Accordion>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(text); }}>
        <Stack gap="sm">
          <Textarea
            label="Message"
            placeholder="For example: investigate why this Rover is not ready in namespace..."
            autosize minRows={3} maxRows={10} maxLength={20000}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.repeat && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={pending || sending}
          />
          <Group justify="flex-end">
            <Button type="submit" aria-keyshortcuts="Control+Enter Meta+Enter" disabled={pending || !text.trim()} loading={sending}>Send (Ctrl+Enter)</Button>
          </Group>
        </Stack>
      </form>
      {handoff && <Handoff name={name} defaultTitle={c.spec.title ?? ""} defaultFindings={messages.filter((m) => m.role === "assistant").at(-1)?.content ?? ""} onClose={() => setHandoff(false)} />}
    </Stack>
  );
}

function Handoff({ name, defaultTitle, defaultFindings, onClose }: { name: string; defaultTitle: string; defaultFindings: string; onClose(): void }) {
  const router = useRouter();
  const { data: options, error } = useLive<NewItemOptions>("/api/new-item-options", () => false);
  const [title, setTitle] = useState(defaultTitle);
  const [findings, setFindings] = useState(defaultFindings);
  const [workflow, setWorkflow] = useState("servicedesk");
  const [repos, setRepos] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const repositories = repos ?? (options?.repositories.some((r) => r.name === "controlplane") ? ["controlplane"] : options?.defaults.repositories ?? []);
  return (
    <Modal opened onClose={onClose} title="Create work item from reviewed findings" size="lg">
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <Text size="sm" c="dimmed">This starts the selected workflow with its normal human gates. A bounded redacted conversation excerpt and origin reference are included. One work item per conversation.</Text>
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
        <Textarea label="Reviewed findings / description" autosize minRows={5} value={findings} onChange={(e) => setFindings(e.currentTarget.value)} />
        <Select label="Workflow" data={(options?.workflows ?? []).map((w) => w.name)} value={workflow} onChange={(v) => v && setWorkflow(v)} allowDeselect={false} />
        <MultiSelect label="Repositories" data={(options?.repositories ?? []).map((r) => r.name)} value={repositories} onChange={setRepos} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>Cancel</Button><Button disabled={!title.trim() || !options || !workflow || !repositories.length} loading={busy} onClick={async () => {
          setBusy(true);
          const item = await act<WorkItem>(`/api/chats/${name}/workitem`, { title, description: findings, workflowRef: workflow, repositoryRefs: repositories }, "Work item created");
          setBusy(false);
          if (item) router.push(`/items/${item.metadata.name}`);
        }}>Create work item</Button></Group>
      </Stack>
    </Modal>
  );
}

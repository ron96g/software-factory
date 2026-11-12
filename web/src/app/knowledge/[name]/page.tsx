"use client";
import { Alert, Anchor, Badge, Button, Card, Grid, Group, ScrollArea, Stack, TagsInput, Text, TextInput, Textarea, Title } from "@mantine/core";
import { IconCheck, IconChevronLeft, IconPencil, IconArchive, IconX, IconWand } from "@tabler/icons-react";
import Link from "next/link";
import { use, useState } from "react";
import type { KnowledgeEntry } from "@/core/model/kinds.ts";
import { parseDraft } from "@/core/model/knowledge-draft.ts";
import type { KnowledgeDetail } from "@/core/ports/app.ts";
import type { TranscriptMessage } from "@/core/ports/transcripts.ts";
import { act, useLive } from "@/ui/api.ts";
import { PhaseBadge, timeAgo } from "@/ui/badges.tsx";
import { MarkdownView } from "@/ui/markdown.tsx";
import { ChatPanel } from "@/ui/run-inspector.tsx";

export default function KnowledgeEntryPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { data: d, error, reload } = useLive<KnowledgeDetail>(`/api/knowledge/${name}`, (n) => n.name === name || n.kind === "Conversation");
  const [editing, setEditing] = useState(false);

  if (error) return <Alert color="red" title="Error">{error}</Alert>;
  if (!d) return <Text c="dimmed">Loading…</Text>;
  const e = d.entry;
  const phase = e.status?.phase ?? "Proposed";
  const p = e.spec.provenance;
  const agent = p?.agent ?? "the agent";

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Anchor component={Link} href="/knowledge" size="sm">
        <Group gap={4}>
          <IconChevronLeft size={14} /> Knowledge
        </Group>
      </Anchor>

      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Group gap="sm">
            <Title order={2}>{e.spec.title}</Title>
            <PhaseBadge phase={phase} size="md" />
          </Group>
          <Text size="sm" c="dimmed">
            {p?.agent ? <>Proposed by <b>{p.agent}</b></> : "Added"} {timeAgo(p?.proposedAt ?? e.metadata.creationTimestamp)}
            {p?.workItem && (
              <>
                {" · from "}
                <Anchor component={Link} href={`/items/${p.workItem}`} size="sm">
                  {p.workItem}
                </Anchor>
              </>
            )}
            {p?.agentRun && <> · run <Text span ff="monospace" size="xs">{p.agentRun}</Text></>}
          </Text>
          <Group gap={4} mt={6}>
            {(e.spec.tags ?? []).map((t) => (
              <Badge key={t} size="sm" variant="outline" color="gray">
                {t}
              </Badge>
            ))}
            <Text size="xs" c="dimmed" ml={4}>
              Scope: {[...(e.spec.scope?.repositories ?? []), ...(e.spec.scope?.workflows ?? [])].join(", ") || "everywhere"}
            </Text>
          </Group>
        </div>
        {!editing && phase !== "Retired" && (
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)} style={{ flexShrink: 0 }}>
            Edit
          </Button>
        )}
      </Group>

      {phase === "Proposed" && <ReviewPanel entry={e} onDone={reload} />}
      {phase === "Rejected" && (
        <Alert color="red" icon={<IconX />} title={`Rejected${e.spec.review?.by ? ` by ${e.spec.review.by}` : ""}`}>
          {e.spec.review?.comment || "No reason given."} Editing the entry sends it back to review.
        </Alert>
      )}
      {phase === "Approved" && (
        <Alert color="teal" icon={<IconCheck />} title={`Approved${e.spec.review?.by ? ` by ${e.spec.review.by}` : ""}`}>
          <Group justify="space-between">
            <Text size="sm">Agents with the knowledge-base skill use this entry as reference material. Editing it sends it back to review.</Text>
            <Button size="xs" variant="subtle" color="gray" leftSection={<IconArchive size={14} />} onClick={async () => (await act(`/api/knowledge/${name}/retire`, {}, "Retired")) && reload()}>
              Retire
            </Button>
          </Group>
        </Alert>
      )}

      <Grid>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card className="sf-surface">
            {editing ? (
              <Editor entry={e} onClose={() => setEditing(false)} onSaved={reload} />
            ) : (
              <MarkdownView>{e.spec.content}</MarkdownView>
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card className="sf-surface">
            <Title order={5} mb="sm">
              Refine with {agent}
            </Title>
            <ChatPanel
              existing={d.conversations}
              start={() => act(`/api/knowledge/${name}/conversations`, {})}
              intro={`Discuss the entry with ${agent}. It can suggest a revised draft; you decide whether to apply it. Nothing is approved automatically.`}
              placeholder="e.g. Make it shorter and add the CLI command"
              suggestions={["Is this still accurate?", "Make it shorter", "Add how to verify it"]}
              footer={(messages) => (phase === "Retired" ? null : <ApplyDraft name={name} messages={messages} onApplied={reload} />)}
            />
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function ReviewPanel({ entry, onDone }: { entry: KnowledgeEntry; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    const r = await act(`/api/knowledge/${entry.metadata.name}/review`, { decision, comment }, decision === "approve" ? "Approved" : "Rejected");
    setBusy(false);
    if (r) onDone();
  };
  return (
    <Alert color="yellow" title="Awaiting your review">
      <Stack gap="xs">
        <Text size="sm">Check that the entry is correct, reusable, and free of customer data and secrets. Edit it first if needed.</Text>
        <Textarea placeholder="Comment (optional; recommended when rejecting)" autosize minRows={1} value={comment} onChange={(ev) => setComment(ev.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" color="red" leftSection={<IconX size={16} />} loading={busy} onClick={() => void decide("reject")}>
            Reject
          </Button>
          <Button color="teal" leftSection={<IconCheck size={16} />} loading={busy} onClick={() => void decide("approve")}>
            Approve
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

function Editor({ entry, onClose, onSaved }: { entry: KnowledgeEntry; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(entry.spec.title);
  const [content, setContent] = useState(entry.spec.content);
  const [tags, setTags] = useState<string[]>(entry.spec.tags ?? []);
  const [busy, setBusy] = useState(false);
  return (
    <Stack>
      <TextInput label="Title" value={title} onChange={(ev) => setTitle(ev.currentTarget.value)} required />
      <Textarea label="Content (Markdown)" autosize minRows={8} value={content} onChange={(ev) => setContent(ev.currentTarget.value)} required />
      <TagsInput label="Tags" value={tags} onChange={setTags} />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={!title.trim() || !content.trim()}
          onClick={async () => {
            setBusy(true);
            const r = await act(`/api/knowledge/${entry.metadata.name}/edit`, { title, content, tags }, "Saved");
            setBusy(false);
            if (r) {
              onSaved();
              onClose();
            }
          }}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

/** Offers the agent's latest suggested draft; applying it is a normal human edit. */
function ApplyDraft({ name, messages, onApplied }: { name: string; messages: TranscriptMessage[]; onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  const last = [...messages].reverse().find((m) => m.role === "assistant" && parseDraft(m.content));
  const draft = last ? parseDraft(last.content) : null;
  if (!draft) return null;
  return (
    <Alert color="indigo" variant="light" icon={<IconWand />} title={`Suggested draft: ${draft.title}`}>
      <ScrollArea.Autosize mah={220} mb="xs">
        <MarkdownView>{draft.content}</MarkdownView>
      </ScrollArea.Autosize>
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Applying replaces the entry and sends it back to review.
        </Text>
        <Button
          size="xs"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            const r = await act(`/api/knowledge/${name}/edit`, draft, "Draft applied");
            setBusy(false);
            if (r) onApplied();
          }}
        >
          Apply this draft
        </Button>
      </Group>
    </Alert>
  );
}

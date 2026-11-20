"use client";
import { Accordion, Alert, Anchor, Button, Card, Checkbox, Group, Modal, MultiSelect, SegmentedControl, Select, Stack, Tabs, Text, Textarea, TextInput, Title } from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { NewItemOptions } from "@/core/ports/app.ts";
import type { DraftFollowUpTicketInput, FollowUpPreview, FollowUpRelations, FollowUpTicketDraft, NewFollowUpInput, NewFollowUpTicketInput } from "@/core/ports/work-item-followups.ts";
import { api, ApiError, useLive } from "./api.ts";
import { MarkdownView } from "./markdown.tsx";
import { PhaseBadge } from "./badges.tsx";

export function WorkItemFollowUps({ item }: { item: WorkItem }) {
  const { data, error } = useLive<FollowUpRelations>(`/api/workitems/${item.metadata.name}/followups`, (n) => n.kind === "WorkItem");
  return (
    <>
      {error && <Alert color="red">{error}</Alert>}
      {data?.origin && (data.origin.available
        ? <Anchor component={Link} href={`/items/${data.origin.name}`} size="sm">Created from: {data.origin.title || data.origin.name}</Anchor>
        : <Text size="sm" c="dimmed">Created from {data.origin.name} (origin unavailable; captured evidence is retained).</Text>)}
      {!!data?.items.length && <Card className="sf-surface"><Title order={5} mb="xs">Follow-ups</Title><Stack gap="xs">
        {data.items.map((w) => <Group key={w.metadata.name} justify="space-between">
          <Anchor component={Link} href={`/items/${w.metadata.name}`}>{w.spec.title}</Anchor>
          <Group gap="xs"><Text size="xs" c="dimmed">{w.spec.workflowRef?.name}</Text><PhaseBadge phase={w.status?.phase} /></Group>
        </Group>)}
      </Stack></Card>}
      {item.spec.originSnapshot && <Accordion variant="contained"><Accordion.Item value="origin">
        <Accordion.Control>Inherited evidence — captured {new Date(item.spec.originSnapshot.capturedAt).toLocaleString()}</Accordion.Control>
        <Accordion.Panel>
          <Text size="sm" c="dimmed" mb="sm">Historical context only. The original item's approvals and workflow state do not apply here.</Text>
          {item.spec.originSnapshot.truncated && <Alert color="yellow" mb="sm">Inherited evidence was truncated to fit the context budget.</Alert>}
          <div style={{ maxHeight: 450, overflowY: "auto" }}><MarkdownView>{item.spec.originSnapshot.content}</MarkdownView></div>
        </Accordion.Panel>
      </Accordion.Item></Accordion>}
    </>
  );
}

export function FollowUpDialog({ item, onClose, prefill }: { item: WorkItem; onClose(): void; prefill?: { title: string; body: string; targetSource?: string } }) {
  const router = useRouter();
  const url = `/api/workitems/${item.metadata.name}/followups`;
  const { data: options, error: optionsError } = useLive<NewItemOptions>("/api/new-item-options", () => false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState(prefill?.title ?? `Follow-up: ${item.spec.title}`);
  const [description, setDescription] = useState("");
  const [context, setContext] = useState(prefill?.body ?? "");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<FollowUpPreview | null>(null);
  const [previewInput, setPreviewInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<NewFollowUpInput | null>(null);
  const [authorizePublication, setAuthorizePublication] = useState(false);
  const [destination, setDestination] = useState<"workitem" | "ticket">(prefill ? "ticket" : "workitem");
  const [ticketSource, setTicketSource] = useState<string | null>(prefill?.targetSource ?? null);
  const [body, setBody] = useState(prefill?.body ?? "");
  const [draft, setDraft] = useState<FollowUpTicketDraft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const targets = options?.issueTargets ?? [];
  const target = targets.find((t) => t.source === ticketSource);
  async function draftTicket(redraft: boolean) {
    if (!preview || !ticketSource) return;
    setDrafting(true); setDraftError(null);
    try {
      const input: DraftFollowUpTicketInput = { expectedRevision: preview.revision, instructions: context, targetSource: ticketSource, title,
        ...(redraft ? { previous: { title, body }, feedback } : {}), ...(draft ? { conversation: draft.conversation } : {}) };
      const next = await api<FollowUpTicketDraft>(`${url}/ticket/draft`, input);
      setDraft(next); setTitle(next.title); setBody(next.body); setFeedback("");
    } catch (e) { setDraftError(e instanceof Error ? e.message : String(e)); }
    finally { setDrafting(false); }
  }
  async function createTicket() {
    if (!preview || !ticketSource) return;
    setCreating(true); setError(null);
    try {
      const input: NewFollowUpTicketInput = { requestId, expectedRevision: preview.revision, title, instructions: context, body, targetSource: ticketSource,
        ...(draft?.draftedBy === "agent" ? { draftConversation: draft.conversation } : {}) };
      await api(`${url}/ticket`, input);
      onClose(); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setCreating(false); }
  }
  useEffect(() => {
    let disposed = false;
    api<FollowUpPreview>(`${url}/preview`, { context: "" }).then((p) => {
      if (!disposed) { setPreview(p); setPreviewInput(""); }
    }).catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!disposed) setLoadingPreview(false); });
    return () => { disposed = true; };
  }, [url]);
  const repositories = repos ?? item.spec.repositoryRefs?.map((r) => r.name) ?? [];
  const invalidRepos = options && repositories.some((r) => !options.repositories.some((o) => o.name === r));
  const changed = previewInput !== context || (!!preview && preview.snapshot.resourceVersion !== item.metadata.resourceVersion);
  const busy = loadingPreview || creating || drafting || !!pending;
  async function submit(input: NewFollowUpInput) {
    setCreating(true); setError(null); setPending(input);
    try {
      const next = await api<WorkItem>(url, input);
      router.push(`/items/${next.metadata.name}`);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPending(null);
      setError(e instanceof Error ? e.message : String(e)); setCreating(false);
    }
  }
  return (
    <Modal opened onClose={onClose} title={destination === "ticket" ? "Create follow-up ticket" : "Create follow-up work item"} size="xl" closeOnClickOutside={!busy} withCloseButton={!busy}>
      <Stack>
        <SegmentedControl value={destination} onChange={(v) => setDestination(v as "workitem" | "ticket")} disabled={busy}
          data={[{ value: "workitem", label: "Work item" }, { value: "ticket", label: "Tracker ticket" }]} />
        {destination === "ticket" && <>
          <Select label="Tracker" placeholder="Choose a source" data={targets.map((t) => ({ value: t.source, label: t.source }))} value={ticketSource} onChange={setTicketSource} allowDeselect={false} required disabled={busy} />
          {target && <Text size="xs" c="dimmed">Type {target.type}{target.project ? ` · project ${target.project}` : ""}{target.issueType ? ` · issue type ${target.issueType}` : ""}{target.labels?.length ? ` · labels ${target.labels.join(", ")}` : ""} (set by the Source; read-only). Clicking Create approves and creates the ticket with the title and description below.</Text>}
        </>}
        <Text size="sm">{destination === "ticket"
          ? "The product owner drafts a short ticket (goal and acceptance criteria) from the evidence below. You review and edit it before creating. The original item stays unchanged."
          : "Create an independent item with its own workflow and human gates. The original item, source synchronization and pending reviews stay unchanged."}</Text>
        {(error || optionsError) && <Alert color="red">{error || optionsError}</Alert>}
        {pending && error && <Alert color="yellow">Creation may already have succeeded. Retry the original request unchanged to recover its result without creating a duplicate.</Alert>}
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required disabled={busy} />
        {destination === "workitem" && <Textarea label="Objective / description" placeholder="What should the new workflow accomplish?" value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={2} maxRows={8} disabled={busy} />}
        {destination === "workitem" && <Select label="Workflow" placeholder="Choose a workflow" data={(options?.workflows ?? []).map((w) => ({ value: w.name, label: w.name }))} value={workflow} onChange={setWorkflow} allowDeselect={false} required disabled={busy} />}
        {destination === "workitem" && item.spec.retrospective && <Checkbox
          label="I explicitly authorize the selected workflow's publication behavior, including commit/push/draft PR before ship approval where configured. Retrospective approval alone does not authorize this."
          checked={authorizePublication} onChange={(e) => setAuthorizePublication(e.currentTarget.checked)} disabled={busy} />}
        {destination === "workitem" && <MultiSelect label="Repositories" data={(options?.repositories ?? []).map((r) => r.name)} value={repositories} onChange={setRepos} disabled={busy} error={invalidRepos ? "An inherited repository is unavailable. Select usable repositories." : undefined} />}
        <Textarea label={destination === "ticket" ? "Requirements / instructions" : "Additional context / instructions"}
          description={destination === "ticket" ? "Requirements the ticket must reflect (e.g. MUST constraints). The product owner turns them into acceptance criteria." : "Your instructions are kept separately from inherited evidence and shown to every agent. No silent truncation."}
          placeholder={destination === "ticket" ? "We MUST keep the original key order..." : "Address this issue by implementing a new feature that does XYZ..."} value={context} onChange={(e) => setContext(e.currentTarget.value)} autosize minRows={4} maxRows={12} disabled={busy} error={context.length > 20000 ? "Instructions exceed the 20,000-character total context budget." : undefined} />
        {changed && <Alert color="yellow">The instructions or origin changed. Refresh the preview before creating; your edits are preserved.</Alert>}
        <Group justify="space-between">
          <Text size="sm" fw={600}>Inherited context preview</Text>
          <Button variant="light" size="xs" loading={loadingPreview} disabled={!!pending || creating || context.length > 20000} onClick={async () => {
            setLoadingPreview(true); setError(null);
            try { setPreview(await api<FollowUpPreview>(`${url}/preview`, { context })); setPreviewInput(context); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setLoadingPreview(false); }
          }}>Refresh context preview</Button>
        </Group>
        {preview && <>
          <Text size="xs" c="dimmed">Captured {new Date(preview.snapshot.capturedAt).toLocaleString()} · origin version {preview.snapshot.resourceVersion} · {preview.instructions.length + preview.snapshot.content.length}/20,000 characters</Text>
          {preview.snapshot.truncated && <Alert color="yellow">Inherited evidence is truncated. Your additional instructions are preserved in full after secret redaction.</Alert>}
          <Card withBorder mah={350} style={{ overflowY: "auto" }}>
            {preview.instructions && <><Text fw={600} size="sm">New instructions</Text><MarkdownView>{preview.instructions}</MarkdownView></>}
            <MarkdownView>{preview.snapshot.content}</MarkdownView>
          </Card>
        </>}
        {destination === "ticket" && <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" fw={600}>Ticket description</Text>
              <Button size="xs" variant={draft ? "default" : "filled"} loading={drafting && !feedback} disabled={busy || !preview || changed || !ticketSource} onClick={() => draftTicket(false)}>
                {draft ? "Draft again from scratch" : "Draft with product owner"}</Button>
            </Group>
            {!ticketSource && <Text size="xs" c="dimmed">Choose a tracker to draft the ticket.</Text>}
            {draftError && <Alert color="red">Drafting failed: {draftError}</Alert>}
            {draft?.reason && <Alert color="yellow">{draft.reason}</Alert>}
            {draft?.draftedBy === "agent" && <Text size="xs" c="dimmed">Drafted by {draft.agent}{draft.model ? ` (${draft.model})` : ""} · recorded in conversation {draft.conversation}. Review it: Create approves exactly this text.</Text>}
            {draft && <Group align="flex-end" wrap="nowrap">
              <TextInput style={{ flex: 1 }} label="Feedback for the product owner" placeholder="Shorter; add a criterion for JSON input; ..." value={feedback} onChange={(e) => setFeedback(e.currentTarget.value)} disabled={busy} />
              <Button variant="light" loading={drafting && !!feedback} disabled={busy || !feedback.trim() || !preview || changed} onClick={() => draftTicket(true)}>Redraft</Button>
            </Group>}
            <Tabs defaultValue="write">
              <Tabs.List><Tabs.Tab value="write">Write</Tabs.Tab><Tabs.Tab value="preview">Preview</Tabs.Tab></Tabs.List>
              <Tabs.Panel value="write" pt="xs">
                <Textarea aria-label="Ticket description" placeholder="Draft with the product owner, or write the ticket here (Markdown)." value={body} onChange={(e) => setBody(e.currentTarget.value)}
                  autosize minRows={8} maxRows={20} disabled={busy} error={body.length > 20000 ? "The description exceeds 20,000 characters." : undefined} />
              </Tabs.Panel>
              <Tabs.Panel value="preview" pt="xs"><div style={{ maxHeight: 400, overflowY: "auto" }}><MarkdownView>{body || "_Nothing yet._"}</MarkdownView></div></Tabs.Panel>
            </Tabs>
            <Text size="xs" c="dimmed">Links to the origin ticket and this work item are added below the description automatically. The full evidence stays here and goes into the implementation item.</Text>
          </Stack>
        </Card>}
        <Group justify="flex-end">
          <Button variant="default" disabled={loadingPreview || creating || drafting} onClick={onClose}>Cancel</Button>
          {destination === "ticket" ? <Button loading={creating} disabled={busy || !title.trim() || !body.trim() || body.length > 20000 || !ticketSource || !preview || changed || !!error} onClick={createTicket}>Create ticket</Button>
          : <Button loading={creating} disabled={creating || loadingPreview || (!pending && (!options || !title.trim() || !workflow || !repositories.length || !!invalidRepos || !preview || changed || !!error || context.length > 20000))} onClick={async () => {
            if (pending) return submit(pending);
            if (!preview || !workflow) return;
            await submit({ requestId, expectedRevision: preview.revision, title, description, context, workflowRef: workflow, repositoryRefs: repositories,
              ...(item.spec.retrospective ? { authorizePublication } : {}) });
          }}>{pending && !creating ? "Retry original request" : "Create & start workflow"}</Button>}
        </Group>
      </Stack>
    </Modal>
  );
}

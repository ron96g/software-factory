"use client";
import { Anchor, Badge, Button, Card, Checkbox, Group, MultiSelect, Select, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import type { IssueProposal } from "@/core/model/kinds.ts";
import type { NewItemOptions, WorkItemDetail } from "@/core/ports/app.ts";
import { act, useLive } from "@/ui/api.ts";
import { PhaseBadge } from "@/ui/badges.tsx";

export const issueNeedsReview = (i: IssueProposal) => (i.status?.phase ?? "Proposed") === "Proposed" && i.spec.review?.decision !== "reject";

function linkedCondition(i: IssueProposal) {
  return i.status?.conditions?.find((c) => c.type === "Linked");
}

/** ADR-0066 §7: edit, retarget, approve, reject and resolve; agents can only propose. */
export function IssueProposalsPanel({ issues, onUse }: { issues: IssueProposal[]; onUse?: (i: IssueProposal) => void }) {
  const { data: options } = useLive<NewItemOptions>(issues.length ? "/api/new-item-options" : null, () => false);
  if (issues.length === 0) return null;
  return (
    <Card className="sf-surface" mb="md">
      <Title order={5} mb={4}>
        Issues
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        Proposed for trackers. Nothing is created until a human approves it.
      </Text>
      <Stack gap="md">
        {issues.map((i) => (
          <IssueRow key={i.metadata.name} issue={i} targets={options?.issueTargets ?? []} options={options} onUse={onUse} />
        ))}
      </Stack>
    </Card>
  );
}

function IssueRow({ issue: i, targets, options, onUse }: { issue: IssueProposal; targets: { source: string; type: string; project?: string }[]; options: NewItemOptions | null; onUse?: (i: IssueProposal) => void }) {
  const phase = i.status?.phase ?? "Proposed";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(i.spec.title);
  const [body, setBody] = useState(i.spec.body);
  const [target, setTarget] = useState<string | null>(i.spec.targetRef?.name ?? null);
  const [pickUp, setPickUp] = useState(!!i.spec.pickUp);
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/issues/${i.metadata.name}`;
  const run = async (url: string, body: unknown, ok: string) => {
    setBusy(true);
    await act(url, body, ok);
    setBusy(false);
  };
  const frozen = phase !== "Proposed" && phase !== "Rejected";
  const linked = linkedCondition(i);
  const ref = i.status?.externalRef;
  const owned = !!i.metadata.ownerReferences?.length;
  const tracked = i.status?.tracked;
  return (
    <Stack gap={6}>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500} lineClamp={1}>
          {i.spec.title}
        </Text>
        <PhaseBadge phase={phase} size="xs" />
      </Group>
      <Group gap={6}>
        <Badge size="xs" variant="outline">{i.spec.purpose}</Badge>
        {i.spec.targetRef ? <Badge size="xs" variant="light">{i.spec.targetRef.name}</Badge> : <Badge size="xs" color="yellow" variant="light">no target</Badge>}
        {ref && (ref.url ? <Anchor href={ref.url} target="_blank" size="xs">{ref.externalId}</Anchor> : <Text size="xs">{ref.externalId}</Text>)}
        {linked?.status === "True" && <Badge size="xs" color="teal" variant="light">linked</Badge>}
        {linked?.reason === "Conflict" && <Badge size="xs" color="red" variant="light" title={linked.message}>conflict</Badge>}
      </Group>
      {tracked && <Text size="xs" c="dimmed">Tracker: {tracked.state}{tracked.assignee ? `, ${tracked.assignee}` : ""}{tracked.updatedAt ? `, updated ${new Date(tracked.updatedAt).toLocaleString()}` : ""}</Text>}
      {i.spec.provenance?.workItem && <Anchor href={`/items/${i.spec.provenance.workItem}`} size="xs">Work item {i.spec.provenance.workItem}</Anchor>}
      {phase === "Created" && (i.spec.purpose === "follow-up" || i.spec.purpose === "story") && <StartImplementation issue={i} options={options} />}
      {linked?.reason === "Conflict" && <Text size="xs" c="red">{linked.message}</Text>}
      {(phase === "Uncertain" || phase === "Failed") && (
        <Text size="xs" c="dimmed">
          {i.status?.conditions?.find((c) => c.type !== "Linked")?.message ?? "The outcome of the last attempt is not confirmed."}
        </Text>
      )}
      {owned && onUse && phase === "Proposed" && i.spec.purpose !== "mirror" && i.spec.purpose !== "story" ? (
        <Group gap="xs">
          <Button size="compact-xs" onClick={() => onUse(i)}>Use</Button>
          <Button size="compact-xs" color="red" variant="light" loading={busy} onClick={() => run(`${base}/review`, { decision: "reject" }, "Dismissed")}>Dismiss</Button>
        </Group>
      ) : owned && !onUse ? null : owned && (i.spec.purpose === "follow-up" || i.spec.purpose === "story") ? null : editing && !frozen ? (
        <Stack gap={6}>
          <TextInput size="xs" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <Textarea size="xs" autosize minRows={4} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
          <Select size="xs" placeholder="Target" data={targets.map((t) => ({ value: t.source, label: `${t.source}${t.project ? ` (${t.project})` : ""}` }))} value={target} onChange={setTarget} />
          <Checkbox size="xs" label="Let agents pick it up" checked={pickUp} onChange={(e) => setPickUp(e.currentTarget.checked)} />
          <Group gap="xs">
            <Button size="compact-xs" loading={busy} onClick={async () => { await run(`${base}/edit`, { title, body, pickUp, targetSource: target ?? undefined }, "Saved; approval is needed again"); setEditing(false); }}>Save</Button>
            <Button size="compact-xs" variant="default" onClick={() => setEditing(false)}>Cancel</Button>
          </Group>
        </Stack>
      ) : (
        <Group gap="xs">
          {!frozen && <Button size="compact-xs" variant="default" onClick={() => setEditing(true)}>Edit</Button>}
          {(phase === "Proposed" || phase === "Rejected") && (
            <>
              <Button size="compact-xs" color="teal" loading={busy} disabled={!i.spec.targetRef} onClick={() => run(`${base}/review`, { decision: "approve" }, "Approved")}>Approve</Button>
              {phase === "Proposed" && <Button size="compact-xs" color="red" variant="light" loading={busy} onClick={() => run(`${base}/review`, { decision: "reject" }, "Rejected")}>Reject</Button>}
            </>
          )}
          {(phase === "Uncertain" || phase === "Failed") && (
            <>
              <Button size="compact-xs" loading={busy} onClick={() => run(`${base}/resolve`, { action: "create-again" }, "Creating again")}>{phase === "Failed" ? "Retry" : "Create again"}</Button>
              <TextInput size="xs" placeholder="Existing issue key" value={existing} onChange={(e) => setExisting(e.currentTarget.value)} />
              <Button size="compact-xs" variant="default" disabled={!existing.trim()} loading={busy} onClick={() => run(`${base}/resolve`, { action: "link", externalId: existing }, "Linked")}>Link existing</Button>
            </>
          )}
        </Group>
      )}
    </Stack>
  );
}

/** ADR-0068: the human confirms where implementation runs; repositories default to the origin item's, never silently to the ticket Source's. */
function StartImplementation({ issue: i, options }: { issue: IssueProposal; options: NewItemOptions | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[] | null>(null);
  const origin = i.spec.provenance?.workItem;
  const { data: detail } = useLive<WorkItemDetail>(open && origin ? `/api/workitems/${origin}` : null, () => false);
  const selected = repos ?? detail?.workItem.spec.repositoryRefs?.map((r) => r.name) ?? [];
  if (!open) return <Group><Button size="compact-xs" onClick={() => setOpen(true)}>Start implementation</Button></Group>;
  return (
    <Stack gap={6}>
      <Select size="xs" label="Workflow" placeholder="Ticket source default" clearable value={workflow} onChange={setWorkflow}
        data={(options?.workflows ?? []).map((w) => ({ value: w.name, label: w.name }))} />
      <MultiSelect size="xs" label="Repositories" description={origin ? `Default: the repositories of ${origin}` : undefined} value={selected} onChange={setRepos}
        data={(options?.repositories ?? []).map((r) => ({ value: r.name, label: r.name }))} error={selected.length ? undefined : "Choose at least one repository"} />
      <Group gap="xs">
        <Button size="compact-xs" loading={busy} disabled={!selected.length} onClick={async () => {
          setBusy(true);
          await act(`/api/issues/${i.metadata.name}/start`, { ...(workflow ? { workflowRef: workflow } : {}), repositories: selected }, "Implementation started");
          setBusy(false);
          setOpen(false);
        }}>Start</Button>
        <Button size="compact-xs" variant="subtle" onClick={() => setOpen(false)}>Cancel</Button>
      </Group>
    </Stack>
  );
}

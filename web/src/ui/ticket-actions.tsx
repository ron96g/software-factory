"use client";
import { Alert, Badge, Button, Card, Checkbox, Group, Modal, Select, Stack, Text, Textarea, Title } from "@mantine/core";
import { useState } from "react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { TicketReview } from "@/core/ports/tickets.ts";
import { api, ApiError, useLive } from "./api.ts";
import { PhaseBadge } from "./badges.tsx";

const transitions = (review: TicketReview) => (review.ticket?.state.transitions ?? []).map((t) => ({
  value: t.id, label: `${t.name} → ${t.to.name}${t.requiresFields ? " (requires Jira form)" : ""}`, disabled: t.requiresFields || t.to.id === review.ticket?.state.id,
}));

export function TicketActionsPanel({ item }: { item: WorkItem }) {
  const url = `/api/workitems/${item.metadata.name}/ticket`;
  const { data, error, reload } = useLive<TicketReview>(item.spec.externalRef ? url : null, (n) => n.workItem === item.metadata.name || n.name === item.metadata.name);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transitionId, setTransitionId] = useState<string | null>(null);
  const [confirmTransition, setConfirmTransition] = useState(false);
  if (!item.spec.externalRef || (!error && !data?.enabled)) return null;
  return <Card className="sf-surface">
    <Stack gap="sm">
      <Group justify="space-between"><Title order={4}>Jira ticket actions</Title><Button size="xs" variant="subtle" onClick={() => void reload()}>Refresh ticket</Button></Group>
      {(error || actionError) && <Alert color="red">{error || actionError}</Alert>}
      {data?.enabled && <>
        <Text size="sm">{data.ticket?.key} · Current Jira status: <b>{data.ticket?.state.name}</b></Text>
        <Text size="sm" c="dimmed">Only explicitly reviewed actions are sent. Automatic clarification posting stays disabled for the service desk.</Text>
        {data.canStartPublication && <Button variant="light" loading={starting} onClick={async () => {
          setStarting(true); setActionError(null);
          try { await api(url, {}); await reload(); }
          catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
          finally { setStarting(false); }
        }}>Start publication review</Button>}
        {data.approval && (data.approval.spec.decision === "approve"
          ? <Alert color="blue">Publication approved. Delivery and the optional status change are tracked below; the workflow finishes after delivery.</Alert>
          : <PublicationReview key={data.approval.metadata.uid} review={data} url={url} onRefresh={reload} />)}
        {data.canTransition && <Group align="end">
          <Select label="Change ticket status independently" placeholder="Choose an available Jira transition" data={transitions(data)} value={transitionId} onChange={setTransitionId} style={{ flex: 1 }} />
          <Button variant="default" disabled={!data.ticket?.state.transitions.some((t) => t.id === transitionId && !t.requiresFields)} onClick={() => setConfirmTransition(true)}>Review status change</Button>
        </Group>}
        {data.deliveries.map((m) => <Card withBorder p="sm" key={m.metadata.name}>
          <Group justify="space-between"><Text size="sm">{m.spec.action === "service-desk-reply" ? "Reply publication" : "Ticket status change"}</Text><PhaseBadge phase={m.status?.phase} /></Group>
          {m.status?.lastError && <Text size="sm" c="red">{m.status.lastError}</Text>}
          {m.status?.result && <Text size="xs" c="dimmed">{Object.entries(m.status.result).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</Text>}
        </Card>)}
      </>}
    </Stack>
    {confirmTransition && data && transitionId && <TransitionConfirmation review={data} transitionId={transitionId} url={url} onClose={() => setConfirmTransition(false)} onDone={() => { setConfirmTransition(false); setTransitionId(null); void reload(); }} />}
  </Card>;
}

function PublicationReview({ review, url, onRefresh }: { review: TicketReview; url: string; onRefresh(): Promise<void> }) {
  const [visibility, setVisibility] = useState<string | null>(null);
  const [transitionId, setTransitionId] = useState<string | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approval = review.approval, proposal = approval?.spec.ticketPublication;
  if (!approval || !proposal) return null;
  const confirmed = !!review.revision && reviewedRevision === review.revision;
  const validVisibility = (visibility === "public" || visibility === "internal") && review.visibilities.includes(visibility);
  return <Stack gap="sm">
    <Title order={5}>Review before publishing</Title>
    <Alert color="yellow">This is a new publication approval. Approving the earlier response review did not send anything to Jira.</Alert>
    {error && <Alert color="red">{error}</Alert>}
    {review.publicationError && <Alert color="red">{review.publicationError}. Reject and redraft to create a fresh review.</Alert>}
    <Textarea label="Exact reply text" value={proposal.body} readOnly autosize minRows={6} maxRows={18} />
    <Text size="xs" c="dimmed">Artifact {proposal.artifact.name} · version {proposal.artifact.version}. A visible factory receipt marker is appended for duplicate detection.</Text>
    <Select label="Reply visibility" required placeholder="Explicitly choose who can see this comment" data={review.visibilities.map((v) => ({ value: v, label: v === "public" ? "Public — visible to the customer" : "Internal — service desk team only" }))} value={visibility} onChange={(v) => { setVisibility(v); setReviewedRevision(null); }} disabled={busy} />
    {visibility && <Badge color={visibility === "public" ? "orange" : "blue"} variant="light">{visibility === "public" ? "Customer-visible reply" : "Internal note"}</Badge>}
    {review.canTransition && <Select label="After publishing, change Jira status (optional)" placeholder="Leave Jira status unchanged" data={transitions(review)} value={transitionId} clearable onChange={(v) => { setTransitionId(v); setReviewedRevision(null); }} disabled={busy} />}
    <Checkbox label="I reviewed the exact reply, visibility and optional status change." checked={confirmed} onChange={(e) => setReviewedRevision(e.currentTarget.checked ? review.revision ?? null : null)} disabled={busy} />
    <Textarea label="Reason to redraft (used when rejecting)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} disabled={busy} />
    <Group justify="space-between">
      <Button color="red" variant="light" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await api(`/api/approvals/${approval.metadata.name}/decide`, { decision: "reject", comment: reason }); await onRefresh(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>Reject &amp; redraft</Button>
      <Button loading={busy} disabled={!confirmed || !validVisibility || !!review.publicationError} onClick={async () => {
        if (visibility !== "public" && visibility !== "internal") return;
        setBusy(true); setError(null);
        try { await api(`${url}/publish`, { revision: review.revision, visibility, transitionId: transitionId ?? undefined }); await onRefresh(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setReviewedRevision(null); }
        finally { setBusy(false); }
      }}>Approve &amp; publish {visibility === "internal" ? "internal note" : "reply"}</Button>
    </Group>
  </Stack>;
}

function TransitionConfirmation({ review, transitionId, url, onClose, onDone }: {
  review: TicketReview; transitionId: string; url: string; onClose(): void; onDone(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [snapshot] = useState({ revision: review.revision, transitionId, from: review.ticket?.state.name, to: review.ticket?.state.transitions.find((t) => t.id === transitionId)?.to.name });
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  return <Modal opened onClose={onClose} withCloseButton={!busy} closeOnClickOutside={!busy} title="Confirm Jira status change">
    <Stack>
      <Text>{review.ticket?.key}: <b>{snapshot.from} → {snapshot.to}</b></Text>
      <Text size="sm">This changes the real Jira ticket without posting a comment or changing the factory workflow.</Text>
      {error && <Alert color="red">{error}</Alert>}
      {uncertain && <Alert color="yellow">The request may already be queued. Retry this unchanged request to recover its receipt.</Alert>}
      <Group justify="flex-end">
        <Button variant="default" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button loading={busy} disabled={rejected} onClick={async () => {
          setBusy(true); setError(null);
          try { await api(`${url}/transition`, { requestId, revision: snapshot.revision, transitionId: snapshot.transitionId }); onDone(); }
          catch (e) {
            const denied = e instanceof ApiError && e.status >= 400 && e.status < 500;
            setRejected(denied); setUncertain(!denied); setError(e instanceof Error ? e.message : String(e));
          } finally { setBusy(false); }
        }}>{uncertain ? "Retry original request" : "Confirm status change"}</Button>
      </Group>
    </Stack>
  </Modal>;
}

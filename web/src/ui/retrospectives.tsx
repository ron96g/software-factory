"use client";
import { Accordion, Alert, Anchor, Badge, Button, Card, Group, Select, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import Link from "next/link";
import { useState } from "react";
import type { RetrospectiveFeedback, WorkItem } from "@/core/model/kinds.ts";
import type { RetrospectiveGroup } from "@/core/ports/retrospectives.ts";
import { api } from "./api.ts";
import { MarkdownView } from "./markdown.tsx";
import { PhaseBadge } from "./badges.tsx";

export function FeedbackReview({ feedback: f, codes, reload }: { feedback: RetrospectiveFeedback; codes: string[]; reload(): Promise<void> }) {
  const [code, setCode] = useState<string | null>(f.spec.review?.issueCode ?? null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(disposition: "open" | "dismissed") {
    setBusy(true); setError("");
    try {
      await api(`/api/retrospective-feedback/${f.metadata.name}/review`, { version: f.metadata.resourceVersion,
        disposition, issueCode: code ?? undefined, comment });
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <Stack gap="xs">
    {f.spec.review && <Text size="sm">Human disposition: {f.spec.review.disposition} by {f.spec.review.by}: {f.spec.review.comment}</Text>}
    {error && <Alert color="red">{error}</Alert>}
    <Select label="Human-reviewed classification" placeholder="Keep current code" data={codes} value={code} onChange={setCode} disabled={busy} clearable />
    <Textarea label="Reason for classification / disposition" value={comment} onChange={(e) => setComment(e.currentTarget.value)} maxLength={1500} disabled={busy} />
    <Group>
      <Button size="xs" variant="light" disabled={!comment.trim() || busy} onClick={() => void submit("open")}>Keep / reclassify</Button>
      <Button size="xs" color="gray" disabled={!comment.trim() || busy} onClick={() => void submit("dismissed")}>Dismiss observation</Button>
    </Group>
  </Stack>;
}

export function RetrospectiveGroupCard({ group: g, reload }: { group: RetrospectiveGroup; reload(): Promise<void> }) {
  const [request, setRequest] = useState<{ requestId: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function investigate() {
    const input = request ?? { requestId: crypto.randomUUID(), revision: g.revision };
    setRequest(input); setBusy(true); setError("");
    try { await api(`/api/retrospectives/${g.id}/investigate`, input); setRequest(null); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <Card className="sf-surface" id={g.id}>
    <Stack>
      <Group justify="space-between">
        <div><Title order={4}>{g.issueCode}</Title><Text size="sm">{g.target.namespace}/{g.target.name} / {g.target.stage} @ {g.target.version || "unverified"}</Text></div>
        <Badge color={g.thresholdMet ? "teal" : "gray"}>{g.thresholdMet ? "Support threshold met" : "Below threshold"}</Badge>
      </Group>
      <Text size="sm">{g.origins} distinct items; {g.roles.length} reporting roles ({g.roles.join(", ") || "none"}).
        Policy {g.policy.version}: {g.policy.minimumOrigins} items and {g.policy.minimumRoles} roles within {g.policy.windowDays} days.
        Retries and repeated reports never add item votes. This is not a confidence score or authorization to change definitions.</Text>
      {error && <Alert color="red">{error}</Alert>}
      <Group>
        <Button size="sm" variant="light" loading={busy} onClick={() => void investigate()}>{request ? "Retry investigation request" : "Start human-requested investigation"}</Button>
        {request && !busy && <Button size="xs" variant="subtle" onClick={() => { setRequest(null); setError(""); }}>Discard request / refresh evidence</Button>}
      </Group>
      {g.investigations.map((item) => <Group key={item.metadata.name} justify="space-between">
        <Anchor component={Link} href={`/items/${item.metadata.name}`}>{item.spec.title} ({item.spec.retrospective?.cycle})</Anchor>
        <PhaseBadge phase={item.status?.phase} />
      </Group>)}
      <Accordion variant="contained">
        {g.reports.map(({ feedback: f, exclusions, eligible, originAvailable }) => <Accordion.Item key={f.metadata.name} value={f.metadata.name}>
          <Accordion.Control>
            {f.spec.reporter.agent} ({f.spec.reporter.role}) - {f.spec.observation.stance}
            <Badge ml="sm" size="xs" color={eligible ? "teal" : "gray"}>{eligible ? "Eligible" : "Excluded"}</Badge>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="xs" ff="monospace">{f.metadata.name} - {f.spec.capturedAt} - {f.spec.executor}</Text>
              <Text size="sm">{exclusions.join("; ") || "Eligible supporting observation"}</Text>
              {originAvailable
                ? <Anchor component={Link} href={`/items/${f.spec.origin.workItem}`}>Origin: {f.spec.origin.workItem}</Anchor>
                : <Alert color="yellow">Origin missing or replaced. The captured evidence remains available.</Alert>}
              <Text size="xs">Item UID: {f.spec.origin.workItemUid}; run UID: {f.spec.origin.agentRunUid}</Text>
              {f.spec.truncated && <Alert color="yellow">Observation text was truncated at capture.</Alert>}
              <MarkdownView>{`### Observation\n${f.spec.observation.observation}\n### Impact\n${f.spec.observation.impact}\n### Suggestion\n${f.spec.observation.suggestion}\n### Evidence\n${f.spec.observation.evidence}`}</MarkdownView>
              <Text size="xs">Pinned workflow chain: {JSON.stringify(f.spec.target.workflowVersions)}</Text>
              {(f.status?.investigations ?? []).filter((link) => !g.investigations.some((w) => w.metadata.uid === link.uid)).map((link) =>
                <Text size="xs" key={link.uid}>Investigation {link.name} is unavailable; cycle {link.cycle} remains recorded and will not automatically repeat.</Text>)}
              <FeedbackReview feedback={f} codes={g.policy.issueCodes} reload={reload} />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>)}
      </Accordion>
    </Stack>
  </Card>;
}

export function RetrospectivePanel({ item }: { item: WorkItem }) {
  const outcome = item.spec.retrospectiveOutcome;
  const [implementation, setImplementation] = useState(outcome?.implementation ?? "");
  const [loadedVersion, setLoadedVersion] = useState(outcome?.loadedVersion ?? "");
  const [benefit, setBenefit] = useState(outcome?.benefit ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!item.spec.retrospective) return null;
  const snapshot = item.spec.retrospective;
  async function save(disposition: "open" | "deferred" | "closed") {
    setBusy(true); setError("");
    try { await api(`/api/retrospectives/${item.metadata.name}/outcome`, { version: item.metadata.resourceVersion, disposition, implementation, loadedVersion, benefit }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <Card className="sf-surface">
    <Stack gap="sm">
      <Title order={4}>Retrospective evidence and outcome</Title>
      <Alert color="blue">Proposal-only. Human approval never edits definitions or authorizes publication. Use Create follow-up for an independently reviewed implementation.</Alert>
      <Anchor component={Link} href={`/retrospectives#${snapshot.group}`}>View current feedback, exclusions and newer evidence</Anchor>
      <Text size="sm">Snapshot captured {snapshot.capturedAt}; {snapshot.origins} supporting items, {snapshot.roles.length} roles.
        Policy {snapshot.policy.version}; cycle {snapshot.cycle}. {snapshot.truncated ? "Snapshot truncated to 12 reports." : ""}</Text>
      <Accordion variant="contained"><Accordion.Item value="snapshot">
        <Accordion.Control>Historical evidence reviewed by the agents</Accordion.Control>
        <Accordion.Panel><Stack>
          {snapshot.reports.map((r) => <div key={r.uid}>
            <Text size="sm" fw={600}>{r.name}: {r.eligible ? "eligible at capture" : r.exclusions.join("; ")}</Text>
            <MarkdownView>{r.spec.observation.observation + "\n\n" + r.spec.observation.evidence}</MarkdownView>
          </div>)}
        </Stack></Accordion.Panel>
      </Accordion.Item></Accordion>
      {error && <Alert color="red">{error}</Alert>}
      {outcome && <Text size="sm">Disposition: {outcome.disposition}, recorded by {outcome.by} at {outcome.at}</Text>}
      <TextInput label="Implementation / merge reference" description="Separate fact, not implied by proposal approval." value={implementation} onChange={(e) => setImplementation(e.currentTarget.value)} maxLength={1500} disabled={busy} />
      <TextInput label="New definition version actually loaded" description="A merge alone does not reload the running factory." value={loadedVersion} onChange={(e) => setLoadedVersion(e.currentTarget.value)} maxLength={1500} disabled={busy} />
      <Textarea label="Observed benefit or regression evidence" description="Include version, sample sizes, counterevidence, and inconclusive results. No automatic effectiveness score." value={benefit} onChange={(e) => setBenefit(e.currentTarget.value)} maxLength={1500} disabled={busy} />
      <Group>
        <Button size="xs" loading={busy} onClick={() => void save(outcome?.disposition ?? "open")}>Record outcome evidence</Button>
        <Button size="xs" variant="light" color="gray" disabled={busy} onClick={() => void save("deferred")}>Defer investigation</Button>
        <Button size="xs" variant="light" color="gray" disabled={busy} onClick={() => void save("closed")}>Close without applying</Button>
      </Group>
    </Stack>
  </Card>;
}

"use client";

import { Accordion, Alert, Badge, Button, Card, Checkbox, Group, List, Menu, Modal, SimpleGrid, Stack, Text, Textarea, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import type { PlanFormat, PlanningRevisionInput, PlanningSections, PlanningWorkspace as Workspace } from "@/core/ports/planning.ts";
import type { CodeLocation, ReviewEvidence } from "@/core/model/planning-review.ts";
import { parsePlanningRevision } from "@/planning-request.ts";
import { api, ApiError } from "./api.ts";
import { MarkdownView } from "./markdown.tsx";
import { EvidenceArtifacts } from "./evidence-artifacts.tsx";

const fullSections = ["outcome", "scope", "approach", "delivery", "acceptance", "risks"] as const;
const sectionsOf = (format: PlanFormat): readonly (keyof PlanningSections)[] => format === "decision-sheet" ? ["risks"] : fullSections;
// Old six-section plans stay fully readable even after the workflow switched to decision sheets (ADR-0051).
const shownSections = (format: PlanFormat, ...documents: (Partial<PlanningSections> | undefined)[]): readonly (keyof PlanningSections)[] =>
  documents.some((document) => document && fullSections.some((key) => key !== "risks" && document[key] !== undefined)) ? fullSections : sectionsOf(format);
const labelsOf = (format: PlanFormat): Record<keyof PlanningSections, string> => ({
  outcome: "Outcome", scope: "Scope", approach: "Approach", delivery: "Delivery",
  acceptance: "Acceptance", risks: format === "decision-sheet" ? "Risks, assumptions and open points" : "Risks",
});
const sourceLabels: Record<string, string> = {
  spec: "What will be built (specification)", "units-of-work": "Units of Work", "validation-plan": "How it is proven (validation plan)",
  "research-notes": "Research and options (research notes)",
};
const readinessLabels = {
  working: "Agents working", "needs-agent-repair": "Needs agent repair", "needs-answers": "Needs your answers",
  ready: "Ready for review", "ready-with-findings": "Ready with disputed findings",
};
const pick = (source: Partial<PlanningSections>, keys: readonly (keyof PlanningSections)[]): PlanningSections => {
  const result: PlanningSections = { risks: "" };
  for (const key of keys) result[key] = source[key] ?? "";
  return result;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Edit {
  sectionsOpen: boolean;
  revision: string;
  draft?: PlanningSections;
  context: string;
  feedback: string;
  decisions: Workspace["decisions"];
  answers: Record<string, string>;
}

/** After plan approval the plan is reference material: one compact card, full text on demand. */
function ApprovedPlan({ workspace }: { workspace: Workspace }) {
  const labels = labelsOf(workspace.format);
  const document = workspace.document;
  return <Card className="sf-surface" withBorder>
    <Stack gap="xs">
      <Group justify="space-between"><Title order={4}>Approved plan</Title><Badge color="teal" variant="light">approved</Badge></Group>
      {document ? <>
        {document.outcome && <MarkdownView>{document.outcome}</MarkdownView>}
        <Accordion variant="contained">
          {workspace.sources.map((source) => <Accordion.Item key={source.artifact} value={source.artifact}>
            <Accordion.Control>{sourceLabels[source.type] ?? source.type}</Accordion.Control>
            <Accordion.Panel><SourceView source={source} /></Accordion.Panel>
          </Accordion.Item>)}
          <Accordion.Item value="plan">
            <Accordion.Control>{workspace.format === "decision-sheet" ? "Decisions and risks" : "Full plan"}</Accordion.Control>
            <Accordion.Panel><Stack>{shownSections(workspace.format, document).filter((key) => key !== "outcome").map((key) => <div key={key}>
              <Title order={5}>{labels[key]}</Title>
              <MarkdownView>{document[key] || "_Not specified._"}</MarkdownView>
            </div>)}
            {workspace.decisions.map((decision) => <div key={decision.id}>
              <Text size="sm" fw={600}>{decision.id}</Text>
              <MarkdownView>{decision.question}</MarkdownView>
              <MarkdownView>{`**Answer:** ${decision.answer ?? (decision.required ? "_none_" : `${decision.recommendation ?? ""} (recommended default)`)}`}</MarkdownView>
            </div>)}</Stack></Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </> : <Text size="sm" c="dimmed">The approved plan is not available in this revision.</Text>}
    </Stack>
  </Card>;
}

function SourceView({ source }: { source: Workspace["sources"][number] }) {
  const json = source.format === "json" || /^\s*[[{]/.test(source.content);
  return <MarkdownView>{json ? `\`\`\`json\n${source.content}\n\`\`\`` : source.content}</MarkdownView>;
}


const codeLabel = (c: CodeLocation) => `${c.repository}:${c.path}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`;
/** Version 2 evidence is `{ artifact }` or `{ code }`; earlier reviews used `{ name, resourceVersion }` and stay readable. */
const evidenceLabel = (entry: ReviewEvidence | { name: string; resourceVersion: string }) =>
  "code" in entry ? codeLabel(entry.code) : "artifact" in entry ? `${entry.artifact.name} @ ${entry.artifact.resourceVersion}` : `${entry.name} @ ${entry.resourceVersion}`;

export default function PlanningWorkspace({ workspace, error, reload, detail, onOpenRun, summary }: {
  workspace: Workspace | null;
  error: string | null;
  reload: () => Promise<void>;
  detail: WorkItemDetail;
  onOpenRun: (name: string) => void;
  /** Construction and later: show the approved plan as a compact reference instead of the editing workspace. */
  summary?: boolean;
}) {
  const item = detail.workItem;
  const storageKey = `factory-planning-request:${item.metadata.namespace}:${item.metadata.name}:${item.metadata.uid ?? ""}`;
  const [pending, setPending] = useState<PlanningRevisionInput | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: "reject" | "defer"; revision: string } | null>(null);
  const [migrationConfirm, setMigrationConfirm] = useState(false);
  const [comment, setComment] = useState("");
  const [override, setOverride] = useState(false);

  useEffect(() => {
    setStorageReady(false);
    setPending(null);
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setPending(parsePlanningRevision(JSON.parse(saved)));
      setStorageReady(true);
    } catch (e) {
      setActionError(`Cannot safely recover the saved planning request: ${errorText(e)}`);
    }
  }, [storageKey]);

  useEffect(() => {
    setComment("");
    setOverride(false);
  }, [workspace?.approval, workspace?.revision]);

  function snapshot(): Edit {
    const source = workspace?.document ?? workspace?.draft;
    const draft = source && workspace ? pick(source, sectionsOf(workspace.format)) : undefined;
    return {
      sectionsOpen: false,
      revision: workspace?.revision ?? "",
      draft,
      context: item.spec.context ?? "",
      feedback: "",
      decisions: workspace?.decisions ?? [],
      answers: Object.fromEntries((workspace?.decisions ?? []).map((decision) => [decision.id, decision.answer ?? ""])),
    };
  }

  async function submit(request: PlanningRevisionInput, isNew: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if (isNew) {
        if (!workspace?.canRevise || error || !storageReady || pending) throw new Error("Refresh planning before making changes.");
        parsePlanningRevision(request);
        if (localStorage.getItem(storageKey)) throw new Error("An earlier request is saved. Reload to recover it before submitting another.");
        // Save before sending: an interrupted response must retry the exact human intent.
        localStorage.setItem(storageKey, JSON.stringify(request));
        setPending(request);
      }
      await api<WorkItem>(`/api/workitems/${encodeURIComponent(item.metadata.name)}/planning`, request);
      localStorage.removeItem(storageKey);
      setPending(null);
      setEdit(null);
      setConfirmation(null);
      notifications.show({ message: request.action === "migrate" ? "One-planner workflow migration requested. Review the regenerated plan before approving."
        : request.action === "reject" ? "Proposal rejected" : request.action === "defer" ? "Proposal deferred"
          : request.withdraw?.length ? "Answer withdrawn. Review the regenerated proposal before approving."
            : "Planning revision requested. Review the regenerated proposal before approving.", color: "teal" });
      await reload();
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404, 409, 422].includes(e.status)) {
        if (request.action === "revise" || request.action === "decisions" && !request.withdraw?.length) {
          setEdit((current) => current ?? {
            sectionsOpen: !!request.draft || request.context !== undefined,
            revision: request.revision, draft: request.draft,
            context: request.context ?? item.spec.context ?? "", feedback: request.feedback ?? "",
            decisions: workspace?.decisions ?? [], answers: request.answers ?? {},
          });
        }
        try {
          localStorage.removeItem(storageKey);
          setPending(null);
        } catch { /* Keep the saved request until its receipt can be recovered. */ }
      }
      setActionError(`${errorText(e)}${e instanceof ApiError && e.status === 409 ? " Your edits are preserved. Compare the refreshed proposal, then cancel editing to start from its new revision." : ""}`);
      if (e instanceof ApiError && e.status === 409) await reload();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function revise(action: PlanningRevisionInput["action"], revision?: string) {
    if (!workspace) return;
    const captured = edit ?? snapshot();
    const intent = action === "revise" || action === "decisions";
    void submit({
      revision: revision ?? captured.revision,
      requestId: crypto.randomUUID(),
      action,
      ...(intent ? {
        context: captured.context,
        ...(captured.draft ? { draft: captured.draft } : {}),
        feedback: captured.feedback,
        ...(action === "decisions" ? { answers: Object.fromEntries(Object.entries(captured.answers).filter(([, answer]) => answer.trim())) } : {}),
      } : {}),
    }, true);
  }

  function withdrawAnswer(decisionId: string) {
    if (!workspace) return;
    void submit({ revision: workspace.revision, requestId: crypto.randomUUID(), action: "decisions", withdraw: [decisionId] }, true);
  }

  if (!workspace?.enabled) return error ? <Alert color="red" title="Planning workspace unavailable">{error}<Button variant="subtle" onClick={() => void reload()}>Retry</Button></Alert> : null;
  if (summary) return <ApprovedPlan workspace={workspace} />;

  const sections = sectionsOf(workspace.format);
  const labels = labelsOf(workspace.format);
  const decisions = edit?.decisions ?? workspace.decisions;
  const disabled = busy || !!pending || !storageReady || !workspace.canRevise || !!error;
  const staleEdit = !!edit && edit.revision !== workspace.revision;
  const missingRequired = decisions.filter((decision) => decision.required
    && !(edit?.answers[decision.id] ?? decision.answer ?? "").trim());
  const hasAnswers = Object.values(edit?.answers ?? {}).some((answer) => answer.trim());
  const blockedMessage = item.status?.phase === "Blocked" ? item.status.message : undefined;
  const approval = detail.approvals.find((a) => a.metadata.name === workspace.approval
    && a.spec.verification?.kind === "plan" && !a.spec.decision);
  const blocking = detail.evidence.status === "blocking";
  const canApprove = !!approval && workspace.ready && storageReady && !edit && !pending && !busy && !error && !workspace.disposition;
  const approvalIssues = staleEdit
    ? ["The plan changed while you were editing. Compare the revisions and cancel editing before starting from the new proposal."]
    : edit
      ? [missingRequired.length > 0
        ? `Answer ${missingRequired.length} remaining required decision(s), then select Submit answers & update plan.`
        : "Submit your answers or save your edits, then review the updated plan before approving. Cancel edits to keep the current proposal."]
      : !workspace.ready ? workspace.issues
        : !approval ? ["There is no pending plan approval at the current workflow stage."] : [];

  async function approve() {
    if (!approval || !canApprove || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/approvals/${encodeURIComponent(approval.metadata.name)}/decide`, {
        decision: "approve", comment, override: blocking ? override : undefined,
      });
      notifications.show({ message: "Plan approved", color: "teal" });
      setComment("");
      setOverride(false);
      await reload();
    } catch (e) {
      setActionError(errorText(e));
      await reload();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <Card className="sf-surface" withBorder style={{ overflowWrap: "anywhere" }}>
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Proposed implementation plan</Title>
        <Group gap="xs">
          {workspace.canMigrate && <Button size="xs" variant="light" disabled={disabled} onClick={() => setMigrationConfirm(true)}>
            Use one-planner workflow
          </Button>}
          <Tooltip label={`Revision ${workspace.revision}`}>
            <Badge color={workspace.disposition ? "gray" : workspace.readiness === "ready" ? "teal" : "yellow"}>
              {workspace.disposition ?? (workspace.readiness ? readinessLabels[workspace.readiness] : workspace.ready ? "Ready for review" : "Agents working")}
            </Badge>
          </Tooltip>
        </Group>
      </Group>
      {error && <Alert color="red" title="Planning refresh failed">{error}</Alert>}
      {actionError && <Alert color="red" title="Planning action needs attention">{actionError}</Alert>}
      {pending && <Alert color="yellow" title="Request awaiting receipt">
        The previous request may already have succeeded. Recover its receipt using the original payload before making another change.
        <Button mt="sm" loading={busy} onClick={() => void submit(pending, false)}>Retry original {pending.action} request</Button>
      </Alert>}
      {staleEdit && <Alert color="yellow">The proposal changed while you were editing. Your captured revision and edits are preserved; saving may report a conflict. Review the comparison before starting a fresh edit.</Alert>}
      {staleEdit && edit && Object.keys(edit.answers).length > 0 && <Accordion variant="contained">
        <Accordion.Item value="captured-answers">
          <Accordion.Control>Captured decision answers (revision {edit.revision})</Accordion.Control>
          <Accordion.Panel><Stack gap="xs">{Object.entries(edit.answers).filter(([, answer]) => answer.trim()).map(([id, answer]) => <div key={id}>
            <Text size="xs" ff="monospace">{id}</Text><MarkdownView>{answer}</MarkdownView>
          </div>)}</Stack></Accordion.Panel>
        </Accordion.Item>
      </Accordion>}
      {blockedMessage && !workspace.issues.some((issue) => issue.includes(blockedMessage))
        && <Alert color="yellow" title="Planning needs attention">{blockedMessage}</Alert>}
      {workspace.readiness === "needs-agent-repair" && workspace.canRevise && <Alert color="yellow" title="The proposal needs agent repair">
        Missing or invalid planning evidence is not a request for you to approve it. Request a fresh planning revision,
        optionally supplying feedback below.
        <Button mt="sm" variant="light" disabled={disabled || !!edit} onClick={() => void submit({
          action: "revise", revision: workspace.revision, requestId: crypto.randomUUID(),
        }, true)}>Retry planning</Button>
      </Alert>}
      {workspace.review && <Stack gap="sm">
        <Title order={4}>Independent planning review</Title>
        <MarkdownView>{workspace.review.summary}</MarkdownView>
        {workspace.review.findings.map((finding) => <Card key={finding.id} withBorder p="sm">
          <Stack gap="xs">
            <Group gap="xs"><Badge color={finding.kind === "human-decision" ? "red" : finding.kind === "advisory" ? "gray" : "yellow"}>
              {finding.kind.replaceAll("-", " ")}
            </Badge><Text size="xs" ff="monospace">{finding.id}</Text></Group>
            <MarkdownView>{finding.summary}</MarkdownView>
            {finding.kind === "research-gap" && <div><Text size="sm" fw={600}>Claim to research</Text><MarkdownView>{finding.claim}</MarkdownView></div>}
            {finding.kind === "research-gap" && finding.investigation && <div>
              <Text size="sm" fw={600}>Investigated</Text>
              {[...(finding.investigation.checked ?? []).map(codeLabel), ...(finding.investigation.searches ?? []).map((q) => `search "${q}"`)].map((entry) =>
                <Text key={entry} size="xs" ff="monospace">{entry}</Text>)}
              <MarkdownView>{finding.investigation.unresolvedBecause}</MarkdownView>
            </div>}
            {finding.kind === "plan-defect" && <div><Text size="sm" fw={600}>Requested correction</Text><MarkdownView>{finding.requestedChange}</MarkdownView></div>}
            {finding.kind === "human-decision" && <Text size="sm">Answer decision {finding.decisionId} below.</Text>}
            <Text size="xs" c="dimmed">Reviewed evidence: {finding.evidence.map(evidenceLabel).join(", ")}</Text>
          </Stack>
        </Card>)}
        {!!workspace.review.verified?.length && <Card withBorder p="sm">
          <Stack gap="xs">
            <Group gap="xs"><Badge color="teal">checked in code</Badge><Text size="xs" c="dimmed">Claims the reviewer confirmed; not findings.</Text></Group>
            {workspace.review.verified.map((claim) => <div key={claim.id}>
              <MarkdownView>{claim.claim}</MarkdownView>
              <Text size="xs" ff="monospace" c="dimmed">{claim.evidence.map(codeLabel).join(", ")}</Text>
            </div>)}
          </Stack>
        </Card>}
        {workspace.readiness === "ready-with-findings" && <Alert color="yellow">
          {workspace.reviewFindings
            ? "The bounded AI repair loop has stopped with unresolved findings. Request another revision, or explicitly accept the remaining concerns with a reason when approving."
            : "The review includes advisory concerns. Read them before deciding whether to approve or request a revision."}
        </Alert>}
      </Stack>}

      {workspace.format === "decision-sheet" && workspace.sources.length > 0 && <Accordion variant="contained" multiple defaultValue={["spec"]}>
        {workspace.sources.map((source) => <Accordion.Item key={source.artifact} value={source.type}>
          <Accordion.Control>{sourceLabels[source.type] ?? source.type}</Accordion.Control>
          <Accordion.Panel><SourceView source={source} /></Accordion.Panel>
        </Accordion.Item>)}
      </Accordion>}
      {workspace.format === "decision-sheet" && <Text size="sm" c="dimmed">The technical design is produced and approved separately after this plan, before any code is written.</Text>}
      {workspace.document || edit?.sectionsOpen ? (edit?.sectionsOpen ? sections : shownSections(workspace.format, workspace.document)).map((key) => <Stack key={key} gap="xs">
        <Title order={4}>{labels[key]}</Title>
        {edit?.sectionsOpen ? <Textarea aria-label={labels[key]} autosize minRows={3}
          value={edit.draft?.[key] ?? ""} disabled={disabled}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setEdit((current) => current && { ...current, draft: { ...(current.draft ?? pick({}, sections)), [key]: text } });
          }} /> : <MarkdownView>{workspace.document?.[key] || "_Not yet specified._"}</MarkdownView>}
      </Stack>) : <Alert color="blue">The planning agents are preparing a proposal. No plan is ready for approval yet.</Alert>}
      {workspace.historyError && <Alert color="yellow" title="Previous proposal unavailable">
        {workspace.historyError} Current proposal readiness is evaluated independently.
      </Alert>}
      {workspace.previous && workspace.document && <Accordion variant="contained">
        <Accordion.Item value="comparison">
          <Accordion.Control>Previous / current proposal — section comparison</Accordion.Control>
          <Accordion.Panel><Stack>{shownSections(workspace.format, workspace.previous, workspace.document).map((key) => <Stack key={key} gap="xs">
            <Title order={5}>{labels[key]} {workspace.previous?.[key] === workspace.document?.[key] ? "(unchanged)" : "(changed)"}</Title>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <div><Text fw={600}>Before</Text><MarkdownView>{workspace.previous?.[key] || "_Empty._"}</MarkdownView></div>
              <div><Text fw={600}>After</Text><MarkdownView>{workspace.document?.[key] || "_Empty._"}</MarkdownView></div>
            </SimpleGrid>
          </Stack>)}</Stack></Accordion.Panel>
        </Accordion.Item>
      </Accordion>}
      {workspace.previous && !workspace.document && <Accordion variant="contained">
        <Accordion.Item value="previous">
          <Accordion.Control>Previous proposal (history, not the current revision)</Accordion.Control>
          <Accordion.Panel><Stack>{shownSections(workspace.format, workspace.previous).map((key) => <div key={key}>
            <Title order={5}>{labels[key]}</Title>
            <MarkdownView>{workspace.previous?.[key] || "_Empty._"}</MarkdownView>
          </div>)}</Stack></Accordion.Panel>
        </Accordion.Item>
      </Accordion>}

      {decisions.length > 0 && <>
      <Title order={4}>Your decisions</Title>
      <Text size="sm" c="dimmed">Answer the required ones together; pick an option or write your own. Recommendations are not chosen for you.</Text>
      {decisions.map((decision) => <Card key={decision.id} withBorder p="sm">
        <Stack gap="xs">
          <Group><Badge color={decision.required ? "red" : "gray"}>{decision.required ? "Required" : "Optional"}</Badge><Text size="xs" ff="monospace">{decision.id}</Text></Group>
          <MarkdownView>{decision.question}</MarkdownView>
          {decision.recommendation && <div><Text fw={600} size="sm">Recommendation (not selected automatically)</Text><MarkdownView>{decision.recommendation}</MarkdownView></div>}
          <div><Text fw={600} size="sm">Rationale</Text><MarkdownView>{decision.rationale}</MarkdownView></div>
          {!!decision.options.length && <Group gap="xs">{decision.options.map((option, index) => <Button
            key={`${index}:${option}`} variant="light" size="xs" style={{ height: "auto", whiteSpace: "normal" }}
            disabled={disabled}
            onClick={() => setEdit((current) => { const captured = current ?? snapshot(); return { ...captured, answers: { ...captured.answers, [decision.id]: option } }; })}
          >{option}</Button>)}</Group>}
          <Textarea label="Your answer (an option or custom text)" autosize minRows={2}
            value={edit?.answers[decision.id] ?? decision.answer ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const answer = event.currentTarget.value;
              setEdit((current) => { const captured = current ?? snapshot(); return { ...captured, answers: { ...captured.answers, [decision.id]: answer } }; });
            }}
          />
        </Stack>
      </Card>)}
      </>}
      {(workspace.recordedAnswers.length > 0 || workspace.withdrawnAnswers.length > 0) && <Accordion variant="contained">
        <Accordion.Item value="answer-history">
          <Accordion.Control>Recorded and withdrawn answers</Accordion.Control>
          <Accordion.Panel><Stack gap="sm">
            {workspace.recordedAnswers.map((answer) => <Card key={`answer:${answer.decisionId}`} withBorder p="sm">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="xs" ff="monospace">{answer.decisionId}</Text>
                  <Badge color={answer.current ? "teal" : "gray"}>{answer.current ? "Current decision" : "Not in current plan"}</Badge>
                </Group>
                <Text size="xs" c="dimmed">Recorded {answer.answeredAt ? new Date(answer.answeredAt).toLocaleString() : "date unavailable"}</Text>
                <MarkdownView>{answer.question}</MarkdownView>
                <MarkdownView>{answer.answer}</MarkdownView>
                <Button variant="light" color="red" size="xs" disabled={disabled || !!edit}
                  onClick={() => withdrawAnswer(answer.decisionId)}>Withdraw answer</Button>
              </Stack>
            </Card>)}
            {workspace.withdrawnAnswers.map((answer, index) => <Card key={`withdrawn:${answer.decisionId}:${answer.at}:${index}`} withBorder p="sm">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="xs" ff="monospace">{answer.decisionId}</Text>
                  <Badge color="gray">Withdrawn</Badge>
                </Group>
                <Text size="xs" c="dimmed">Withdrawn {new Date(answer.at).toLocaleString()} by {answer.withdrawnBy}</Text>
                <MarkdownView>{answer.question}</MarkdownView>
                <MarkdownView>{answer.answer}</MarkdownView>
              </Stack>
            </Card>)}
          </Stack></Accordion.Panel>
        </Accordion.Item>
      </Accordion>}
      {(workspace.issues.length > 0 || workspace.unansweredQuestions.length > 0) && <Alert color="yellow" title="Remaining issues / unanswered questions">
        <List size="sm">{[...workspace.issues, ...workspace.unansweredQuestions].map((issue, index) => <List.Item key={index}><MarkdownView>{issue}</MarkdownView></List.Item>)}</List>
      </Alert>}

      {(workspace.canRevise || !!edit) && <>
      <Title order={4}>Request changes</Title>
      {!edit?.sectionsOpen && <>
        <MarkdownView>{item.spec.context || "_No additional context._"}</MarkdownView>
        <Button variant="light" disabled={disabled}
          onClick={() => setEdit((current) => ({ ...(current ?? snapshot()), sectionsOpen: true }))}>Edit plan sections / additional context</Button>
      </>}
      {edit?.sectionsOpen && <Textarea label="Additional context" autosize minRows={3} value={edit.context} disabled={disabled}
        onChange={(event) => {
          const context = event.currentTarget.value;
          setEdit((current) => current && { ...current, context });
        }} />}
      <Textarea label="Feedback / requested changes" description="Bundle requested changes for the next proposal. This does not close or approve the item."
        autosize minRows={3} value={edit?.feedback ?? ""} disabled={disabled}
        onChange={(event) => { const feedback = event.currentTarget.value; setEdit((current) => ({ ...(current ?? snapshot()), feedback })); }} />
      <Group>
        {decisions.length > 0 && <Button disabled={disabled || !edit || staleEdit || missingRequired.length > 0 || !hasAnswers} loading={busy}
          onClick={() => revise("decisions")}>Submit answers &amp; update plan</Button>}
        <Button variant="light" disabled={disabled || !edit || staleEdit} loading={busy} onClick={() => revise("revise")}>Save edits / request changes</Button>
        {edit && <Button variant="subtle" disabled={busy || !!pending} onClick={() => setEdit(null)}>Cancel edits</Button>}
      </Group>
      {missingRequired.length > 0 && <Text size="sm" c="red">
        Answer all {missingRequired.length} remaining required decision(s), then select Submit answers &amp; update plan. Optional recommendations can remain untouched.
      </Text>}
      {edit && <Text size="xs" c="dimmed">“Save edits” does not submit decision answers. “Submit answers &amp; update plan” includes your section edits, context and feedback in one revision.</Text>}
      </>}

      {approval && <Card withBorder p="sm">
        <Stack gap="sm">
          <Title order={4}>Approve this plan</Title>
          <Badge color={blocking ? "red" : detail.evidence.status === "warning" ? "yellow" : "teal"}>{detail.evidence.status}</Badge>
          {detail.evidence.items.map((entry, index) => <div key={index}>
            <Text size="sm" fw={600}>{entry.label} ({entry.severity})</Text>
            <MarkdownView>{entry.detail}</MarkdownView>
            <EvidenceArtifacts refs={entry.artifacts} artifacts={detail.artifacts} />
            {entry.runName && <Button variant="subtle" size="xs" onClick={() => onOpenRun(entry.runName!)}>Open evidence run</Button>}
          </div>)}
          {approval?.spec.criteria?.length ? <List size="sm">{approval.spec.criteria.map((criterion, index) => <List.Item key={index}>{criterion}</List.Item>)}</List> : null}
          {blocking && <Alert color="red">Blocking evidence requires an explicit override and a reason of at least 10 characters. An override cannot bypass missing or stale planning evidence, unanswered required decisions, or verification policy.</Alert>}
          {workspace.reviewFindings && !blocking && <Alert color="yellow" title="The AI plan review still requests changes">
            Read its findings above. You decide: request a revision, or approve with a short reason why the plan is acceptable anyway.
          </Alert>}
          <Textarea label={blocking ? "Override reason (required, at least 10 characters)"
            : workspace.reviewFindings ? "Reason for approving despite the AI review findings (required, at least 10 characters)" : "Approval comment (optional)"}
            autosize value={comment} disabled={busy || !approval}
            onChange={(event) => setComment(event.currentTarget.value)} />
          {blocking && <Checkbox label="I understand the evidence is failing and want to approve anyway"
            checked={override} disabled={busy || !approval} onChange={(event) => setOverride(event.currentTarget.checked)} />}
          <Button color={blocking ? "red" : "teal"} loading={busy}
            disabled={!canApprove || (blocking && (!override || comment.trim().length < 10)) || (!!workspace.reviewFindings && comment.trim().length < 10)}
            onClick={() => void approve()}>Approve reviewed plan revision</Button>
          {approvalIssues.length > 0 && <Alert color="yellow" title="Before you can approve">
            <List size="sm">{approvalIssues.map((issue, index) => <List.Item key={index}>{issue}</List.Item>)}</List>
          </Alert>}
        </Stack>
      </Card>}
      {workspace.canRevise && !edit && <Group justify="flex-end">
        <Menu position="bottom-end">
          <Menu.Target><Button variant="subtle" color="gray" size="xs" disabled={disabled}>Close proposal…</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item color="red" onClick={() => setConfirmation({ action: "reject", revision: workspace.revision })}>Reject proposal</Menu.Item>
            <Menu.Item onClick={() => setConfirmation({ action: "defer", revision: workspace.revision })}>Defer proposal</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>}
    </Stack>
    <Modal opened={!!confirmation && !pending} onClose={() => setConfirmation(null)}
      title={confirmation?.action === "reject" ? "Reject this proposal?" : "Defer this proposal?"}>
      <Stack>
        <Text>{confirmation?.action === "reject"
            ? "Rejecting closes this proposal with an audited rejected disposition. To request a revised proposal instead, cancel and use bundled feedback."
            : "Deferring closes this proposal with an audited deferred disposition. This does not approve construction."}</Text>
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button color={confirmation?.action === "reject" ? "red" : "blue"} loading={busy} disabled={disabled}
            onClick={() => confirmation && revise(confirmation.action, confirmation.revision)}>Confirm {confirmation?.action}</Button>
        </Group>
      </Stack>
    </Modal>
    <Modal opened={migrationConfirm && !pending} onClose={() => setMigrationConfirm(false)} title="Use the one-planner workflow?">
      <Stack>
        <Text>This changes the item to a workflow with a single planner run and restarts at its planner stage.</Text>
        <Alert color="yellow">Planning and later evidence from the previous workflow will be superseded. Existing answers are preserved as planning context, but this migration is not approval; a fresh independent review and human plan approval are required.</Alert>
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={() => setMigrationConfirm(false)}>Cancel</Button>
          <Button loading={busy} disabled={disabled || !workspace.canMigrate} onClick={() => void submit({
            revision: workspace.revision, requestId: crypto.randomUUID(), action: "migrate", workflow: "factory-plan",
          }, true)}>Confirm migration</Button>
        </Group>
      </Stack>
    </Modal>
  </Card>;
}

"use client";

import { Alert, Anchor, Badge, Card, Group, List, Spoiler, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";
import type { RecoveryEpisode } from "@/core/model/recovery.ts";
import { LABEL_SUPERSEDED, type CheckRun } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import { MarkdownView } from "./markdown.tsx";
import { useLive } from "./api.ts";

const STATE: Record<RecoveryEpisode["disposition"], { label: string; color: string }> = {
  diagnosing: { label: "Autonomous diagnosis", color: "blue" },
  repairing: { label: "Autonomous repair", color: "blue" },
  waiting: { label: "Waiting to recover", color: "violet" },
  blocked: { label: "A specific human action is required", color: "yellow" },
  failed: { label: "Technical recovery exhausted", color: "red" },
  resolved: { label: "Recovery completed", color: "teal" },
};

function reportSummary(content: string) {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) {
    if (error instanceof SyntaxError) return <Alert color="red">The retained report is not valid JSON; it cannot authorize recovery.</Alert>;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return <Alert color="red">Recovery report content is unavailable.</Alert>;
  const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every((entry) => typeof entry === "string");
  return <Stack gap="xs">
    {"facts" in value && strings(value.facts) && value.facts.length > 0 && <>
      <Text size="sm" fw={600}>Observed failure and evidence</Text>
      <List size="sm">{value.facts.map((fact, index) => <List.Item key={index}><MarkdownView>{fact}</MarkdownView></List.Item>)}</List>
    </>}
    {"recommendation" in value && typeof value.recommendation === "string" && <Text size="sm">Recommended next action: {value.recommendation}</Text>}
    {"obligations" in value && strings(value.obligations) && value.obligations.length > 0 && <>
      <Text size="sm" fw={600}>Still required</Text>
      <List size="sm">{value.obligations.map((obligation, index) => <List.Item key={index}><MarkdownView>{obligation}</MarkdownView></List.Item>)}</List>
    </>}
    {"humanNeed" in value && !!value.humanNeed && typeof value.humanNeed === "object" && !Array.isArray(value.humanNeed) && <>
      {"need" in value.humanNeed && typeof value.humanNeed.need === "string" && <MarkdownView>{value.humanNeed.need}</MarkdownView>}
      {"options" in value.humanNeed && strings(value.humanNeed.options) && <List type="ordered" size="sm">
        {value.humanNeed.options.map((option, index) => <List.Item key={index}><MarkdownView>{option}</MarkdownView></List.Item>)}
      </List>}
      {"recommendation" in value.humanNeed && typeof value.humanNeed.recommendation === "string" &&
        <MarkdownView>{value.humanNeed.recommendation}</MarkdownView>}
    </>}
  </Stack>;
}

export function RecoveryPanel({ detail }: { detail: WorkItemDetail }) {
  const episode = detail.workItem.status?.recovery?.at(-1);
  const { data: checks, error: checkError } = useLive<{ runs: CheckRun[] }>(
    episode ? `/api/workitems/${encodeURIComponent(detail.workItem.metadata.name)}/checks` : null,
    (notice) => notice.workItem === detail.workItem.metadata.name || notice.kind === "CheckRun");
  if (!episode) return null;
  const state = STATE[episode.disposition];
  const history = detail.workItem.status!.recovery!.filter((entry) =>
    entry.planFingerprint === episode.planFingerprint && entry.unit === episode.unit);
  const agentAttempts = history.reduce((total, entry) => total + entry.diagnosticAttempts + entry.codeAttempts + entry.executionAttempts, 0);
  const diagnosticJobs = checks?.runs.filter((check) =>
    check.spec.workItemUid === episode.workItemUid && check.spec.workflow?.planFingerprint === episode.planFingerprint &&
    check.spec.workflow.unit === episode.unit && ["diagnostic", "baseline"].includes(check.spec.workflow.purpose ?? "")).length;
  const allowance = episode.maxTotalAttempts + history.reduce((total, entry) => total + entry.operatorAllowance, 0);
  const report = detail.artifacts.find((artifact) =>
    artifact.metadata.name === episode.latestReport?.name &&
    artifact.metadata.resourceVersion === episode.latestReport.resourceVersion &&
    artifact.metadata.ownerReferences?.some((owner) => owner.kind === "WorkItem" && owner.uid === episode.workItemUid) &&
    !artifact.metadata.labels?.[LABEL_SUPERSEDED] && !artifact.metadata.labels?.["factory.ai-dlc.io/replay"]);
  return <Card className="sf-surface">
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Technical recovery</Title>
        <Badge color={state.color}>{state.label}</Badge>
      </Group>
      <Text size="sm">Unit {episode.unit} · policy {episode.policyVersion}</Text>
      <Text size="sm">
        Attempts consumed: {episode.diagnosticAttempts} diagnostic, {episode.codeAttempts} code, {episode.executionAttempts} execution.
      </Text>
      {diagnosticJobs !== undefined && !checkError
        ? <Text size="sm">Total for this approved Unit: {agentAttempts + diagnosticJobs} of {allowance} allowed
          {" "}({diagnosticJobs} diagnostic/baseline jobs). Restarting or changing the candidate does not reset the budget.</Text>
        : <Text size="sm">Recorded agent attempts: {agentAttempts}. Full budget consumption is unavailable until diagnostic jobs load.</Text>}
      {checkError && <Alert color="red" title="Recovery job evidence unavailable">{checkError}</Alert>}
      <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>Approved plan: {episode.planFingerprint}</Text>
      <Text size="sm">Original failure: <Anchor component={Link} href={`/resources/${episode.trigger.kind === "CheckRun" ? "checkruns" : "agentruns"}/${encodeURIComponent(episode.trigger.name)}`}>
        {episode.trigger.name}
      </Anchor></Text>
      {episode.retryAt && episode.disposition === "waiting" && <Text size="sm">Next recovery attempt: {episode.retryAt}</Text>}
      {episode.disposition === "failed" && <Alert color="red">
        The factory stopped technical recovery rather than asking you to debug or approving incomplete work.
        Retained work and evidence remain available. Existing plan, review, verification and publication gates still apply.
      </Alert>}
      {report ? <Stack gap="xs">
        <Group justify="space-between">
          <Title order={5}>Latest recovery report</Title>
          <Anchor component={Link} href={`/resources/artifacts/${encodeURIComponent(report.metadata.name)}`} size="xs">Exact report</Anchor>
        </Group>
        {reportSummary(report.spec.content)}
        <Text size="xs" c="dimmed">This recommendation is not an approval or proof that checks passed.</Text>
        <Spoiler maxHeight={240} showLabel="Show full recovery report" hideLabel="Collapse report">
          <MarkdownView>{`\`\`\`json\n${report.spec.content}\n\`\`\``}</MarkdownView>
        </Spoiler>
      </Stack> : <Text size="sm" c="dimmed">{episode.latestReport
        ? "The exact recovery report is unavailable. Missing evidence is not a pass."
        : "No eligible diagnostic report has been produced yet."}</Text>}
    </Stack>
  </Card>;
}

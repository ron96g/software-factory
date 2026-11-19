"use client";

import { Alert, Badge, Button, Card, Group, List, Stack, Table, Text, Title } from "@mantine/core";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { VerificationActions } from "@/core/ports/verification.ts";
import { useLive } from "./api.ts";

type Inspection = Awaited<ReturnType<VerificationActions["inspect"]>>;

/** Verification contract of a verification-enabled workflow (ADR-0042); hidden for workflows without a policy (ADR-0074). */
export function VerificationContractPanel({ item }: { item: WorkItem }) {
  const url = `/api/workitems/${encodeURIComponent(item.metadata.name)}/verification`;
  const { data, error, reload } = useLive<Inspection>(url, (notice) =>
    notice.workItem === item.metadata.name || notice.name === item.metadata.name
    || ["Artifact", "Approval", "Workflow", "Repository"].includes(notice.kind ?? ""));
  if (!error && !data?.enabled) return null;

  return <Card className="sf-surface">
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Verification contract</Title>
        <Button size="xs" variant="subtle" onClick={() => void reload()}>Refresh verification</Button>
      </Group>
      <Group gap="xs">
        <Badge color={data ? "blue" : "gray"}>{data ? "Verified workflow" : "Status unavailable"}</Badge>
        <Text size="sm">Workflow: {data?.workflow ?? item.spec.workflowRef?.name ?? "not selected"}</Text>
      </Group>
      <Alert color={data?.publicationDisabled ? "yellow" : "blue"} title={data ? data.publicationDisabled ? "Publication on hold" : "No verification publication hold" : "Publication status unavailable"}>
        {data ? data.publicationDisabled
          ? "Publication is currently held by verification policy."
          : "Verification policy does not currently hold publication; existing publication rules and permissions still apply."
          : "Refresh verification to inspect the current publication hold."}
        {" "}Plan approval, passing checks and any policy-permitted waiver do not grant publication permission. This card cannot enable publication.
      </Alert>
      {!!data?.gaps?.length && (
        <Alert color={data.gaps.some((g) => !g.waivable) ? "red" : "yellow"} title="Checks without a configured command">
          {data.gaps.map((g) => `${g.repository}/${g.check}`).join(", ")} cannot produce evidence. {data.gaps.some((g) => !g.waivable)
            ? "Non-waivable ones stop verification until an operator configures them."
            : "They stay NotVerified and need an explicit waiver at verification unless an operator configures them first."}
        </Alert>
      )}
      <Text size="sm">Validation plans require fresh human approval of the exact scope. Missing, stale, simulated or unsupported required checks cannot automatically pass. Use the existing human approval cards to review the plan and any policy-permitted, explicitly scoped waiver; a waiver is not a pass.</Text>
      {error && <Alert color="red" title="Unable to inspect verification">{error}</Alert>}
      {data?.error && <Alert color="red" title="Verification contract needs attention">{data.error}</Alert>}
      {data?.plan ? <Stack gap="xs">
        <Title order={5}>Current validation-plan scope</Title>
        <Text size="sm" c="dimmed">This is the current plan, not proof of approval or completed verification.</Text>
        <Table.ScrollContainer minWidth={500}>
          <Table withTableBorder withColumnBorders>
            <Table.Thead><Table.Tr><Table.Th>Criterion</Table.Th><Table.Th>Description</Table.Th><Table.Th>Exact named checks</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {data.plan.criteria.map((criterion, index) => <Table.Tr key={`${index}:${criterion.id}`}>
                <Table.Td><Text size="sm" ff="monospace">{criterion.id}</Text></Table.Td>
                <Table.Td><Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{criterion.description}</Text></Table.Td>
                <Table.Td>{criterion.checks.length
                  ? <List size="sm">{criterion.checks.map((check, i) => <List.Item key={`${i}:${check}`}><Text span ff="monospace" style={{ overflowWrap: "anywhere" }}>{check}</Text></List.Item>)}</List>
                  : <Text size="sm" c="red">No checks mapped — not verified</Text>}</Table.Td>
              </Table.Tr>)}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {!data.plan.criteria.length && <Text size="sm" c="red">No acceptance criteria are mapped.</Text>}
        <Title order={5}>Required checks</Title>
        {data.plan.checks.length
          ? <List size="sm">{data.plan.checks.map((check, index) => <List.Item key={`${index}:${check}`}><Text span ff="monospace" style={{ overflowWrap: "anywhere" }}>{check}</Text></List.Item>)}</List>
          : <Text size="sm" c="dimmed">No checks declared; this does not establish a pass.</Text>}
        <Title order={5}>Same-environment preflight</Title>
        {data.plan.preflight.length
          ? <List size="sm">{data.plan.preflight.map((check, index) => <List.Item key={`${index}:${check}`}><Text span ff="monospace" style={{ overflowWrap: "anywhere" }}>{check}</Text></List.Item>)}</List>
          : <Text size="sm" c="dimmed">No preflight checks declared.</Text>}
      </Stack> : data && <Text size="sm" c="dimmed">No current validation plan is available.</Text>}
    </Stack>
  </Card>;
}

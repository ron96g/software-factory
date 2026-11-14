"use client";

import { Alert, Badge, Button, Card, Group, List, Modal, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import type { WorkItem } from "@/core/model/kinds.ts";
import type { VerificationActions } from "@/core/ports/verification.ts";
import { api, useLive } from "./api.ts";

type Inspection = Awaited<ReturnType<VerificationActions["inspect"]>>;
type MigrationRequest = { workflow: "factory-verified"; requestId: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function VerificationContractPanel({ item }: { item: WorkItem }) {
  const url = `/api/workitems/${encodeURIComponent(item.metadata.name)}/verification`;
  const storageKey = `factory-verification-request:${item.metadata.namespace}:${item.metadata.name}:${item.metadata.uid ?? ""}`;
  const { data, error, reload } = useLive<Inspection>(url, (notice) =>
    notice.workItem === item.metadata.name || notice.name === item.metadata.name
    || ["Artifact", "Approval", "Workflow", "Repository"].includes(notice.kind ?? ""));
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState<MigrationRequest | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const stopped = ["Failed", "Done", "Closed"].includes(item.status?.phase ?? "");

  useEffect(() => {
    setReady(false);
    setPending(null);
    setActionError(null);
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const request: unknown = JSON.parse(saved);
        if (!request || typeof request !== "object" || Array.isArray(request)
          || !("workflow" in request && request.workflow === "factory-verified")
          || !("requestId" in request && typeof request.requestId === "string" && request.requestId.trim() && request.requestId.length <= 200)
          || Object.keys(request).some((key) => !["workflow", "requestId"].includes(key))) {
          throw new Error("The saved request is invalid. Resolve it before submitting another migration.");
        }
        setPending({ workflow: request.workflow, requestId: request.requestId });
      }
      setReady(true);
    } catch (e) {
      setActionError(`Cannot safely restore the previous migration request: ${errorText(e)}`);
    }
  }, [storageKey]);

  async function submit(request: MigrationRequest, isNew: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if (isNew) {
        if (!ready || !stopped || !data || data.enabled || error) throw new Error("Refresh the item before requesting migration.");
        if (localStorage.getItem(storageKey)) throw new Error("An earlier migration request is saved. Reload to recover it.");
        localStorage.setItem(storageKey, JSON.stringify(request));
        setPending(request);
      }
      await api<WorkItem>(url, request);
      localStorage.removeItem(storageKey);
      setPending(null);
      setConfirm(false);
      notifications.show({ message: "Verified workflow requested. A fresh human validation-plan review is required.", color: "teal" });
      await reload();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <Card className="sf-surface">
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Verification contract</Title>
        <Button size="xs" variant="subtle" onClick={() => void reload()}>Refresh verification</Button>
      </Group>
      <Group gap="xs">
        <Badge color={data ? data.enabled ? "blue" : "gray" : "gray"}>
          {data ? data.enabled ? "Verified workflow enabled" : "Legacy workflow" : "Status unavailable"}
        </Badge>
        <Text size="sm">Workflow: {data?.workflow ?? item.spec.workflowRef?.name ?? "not selected"}</Text>
      </Group>
      <Alert color={data?.publicationDisabled ? "yellow" : "blue"} title={data ? data.publicationDisabled ? "Publication on hold" : "No verification publication hold" : "Publication status unavailable"}>
        {data ? data.publicationDisabled
          ? "Publication is currently held by verification policy."
          : "Verification policy does not currently hold publication; existing publication rules and permissions still apply."
          : "Refresh verification to inspect the current publication hold."}
        {" "}Migration to factory-verified always enables the publication hold. Plan approval, passing checks and any policy-permitted waiver do not grant publication permission. This card cannot enable publication.
      </Alert>
      <Text size="sm">Validation plans require fresh human approval of the exact scope. Missing, stale, simulated or unsupported required checks cannot automatically pass. Use the existing human approval cards to review the plan and any policy-permitted, explicitly scoped waiver; a waiver is not a pass.</Text>
      {error && <Alert color="red" title="Unable to inspect verification">{error}</Alert>}
      {data?.error && <Alert color="red" title="Verification contract needs attention">{data.error}</Alert>}
      {actionError && <Alert color="red" title="Migration request needs attention">{actionError}</Alert>}
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
      </Stack> : <Text size="sm" c="dimmed">{data ? "No current validation plan is available." : "Loading verification contract…"}</Text>}
      {pending ? <Alert color="yellow" title="Migration awaiting receipt">
        The original request to use factory-verified may already have succeeded. Retry the saved request to recover its receipt; this does not create a new migration request.
        <Button mt="sm" size="xs" loading={busy} onClick={() => void submit(pending, false)}>Retry original migration request</Button>
      </Alert> : data && !data.enabled && stopped
        ? <Button variant="light" disabled={!ready || busy || !!error} onClick={() => setConfirm(true)}>Use verified workflow</Button>
        : data && !data.enabled && <Text size="sm" c="dimmed">Migration is available only when this item is Failed, Done or Closed. Nothing migrates automatically.</Text>}
    </Stack>
    <Modal opened={confirm && !pending} onClose={() => setConfirm(false)} title="Confirm verified workflow migration">
      <Stack>
        <Text>Use the named workflow <b>factory-verified</b> for this item?</Text>
        <Alert color="yellow">This restarts from validation planning. The workspace and history are preserved, but later outputs and reviews are invalidated. A fresh human validation-plan review is required before verified construction continues.</Alert>
        <Text size="sm">Migration enables the publication hold. This action does not approve the plan, waive missing evidence or grant permission to publish.</Text>
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
          <Button loading={busy} disabled={!ready || !stopped || !data || data.enabled || !!error} onClick={() => void submit({ workflow: "factory-verified", requestId: crypto.randomUUID() }, true)}>Confirm migration</Button>
        </Group>
      </Stack>
    </Modal>
  </Card>;
}

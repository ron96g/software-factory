"use client";

import { Alert, Badge, Button, Card, Group, Modal, Select, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { CheckRun, WorkItem } from "@/core/model/kinds.ts";
import type { CheckOption } from "@/core/ports/checks.ts";
import type { TranscriptMessage } from "@/core/ports/transcripts.ts";
import { api, useLive } from "./api.ts";

type Inspection = { runs: CheckRun[]; options: CheckOption[] };
type Request = { workspace: string; check: string; requestId: string };
type LogPage = { messages: TranscriptMessage[]; nextAfterSeq: number | null; hasMore: boolean };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const duration = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;

export function CheckRunsPanel({ item }: { item: WorkItem }) {
  const url = `/api/workitems/${encodeURIComponent(item.metadata.name)}/checks`;
  const storageKey = `factory-check-request:${item.metadata.namespace}:${item.metadata.name}:${item.metadata.uid ?? ""}`;
  const { data, error, reload } = useLive<Inspection>(url, (n) => n.kind === "CheckRun" || n.workItem === item.metadata.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const stopped = ["Failed", "Done", "Closed"].includes(item.status?.phase ?? "");
  const running = data?.runs.some((r) => !r.status?.phase || r.status.phase === "Running") ?? false;
  const option = data?.options.find((o) => JSON.stringify([o.workspace, o.check]) === selected);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const request: unknown = JSON.parse(saved);
        if (!request || typeof request !== "object"
          || !("workspace" in request && typeof request.workspace === "string")
          || !("check" in request && typeof request.check === "string")
          || !("requestId" in request && typeof request.requestId === "string")) {
          throw new Error("The saved request is invalid. Resolve it before submitting another check.");
        }
        setPending(request as Request);
      }
      setReady(true);
    } catch (e) {
      setActionError(`Cannot safely restore the previous check request: ${errorText(e)}`);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!running && !pending) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [running, pending, reload]);

  async function submit(request: Request, isNew: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if (isNew) {
        if (localStorage.getItem(storageKey)) throw new Error("An earlier request is already saved. Reload to recover it.");
        localStorage.setItem(storageKey, JSON.stringify(request));
        setPending(request);
      }
      await api<CheckRun>(url, request);
      localStorage.removeItem(storageKey);
      setPending(null);
      setConfirm(false);
      setSelected(null);
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
        <Title order={4}>Check evidence</Title>
        <Button size="xs" variant="subtle" onClick={() => void reload()}>Refresh</Button>
      </Group>
      <Text size="sm">Workflow checks follow the approved validation plan. Preparation runs before candidate review and is not final verification evidence. Manual standalone checks do not advance the workflow.</Text>
      <Text size="sm" c="dimmed">Manual checks are available only on stopped items. Configured budgets may be long; checks cannot run while the workspace is busy.</Text>
      {(error || actionError) && <Alert color="red">{error || actionError}</Alert>}
      {pending ? <Alert color="yellow" title="Check request awaiting receipt">
        The request for {pending.check} on {pending.workspace} may already have been submitted. Retry the original request to recover its receipt; no new request will be created.
        <Button mt="sm" size="xs" loading={busy} onClick={() => void submit(pending, false)}>Retry original request</Button>
      </Alert> : <>
        <Group align="end">
          <Select
            label="Configured check"
            placeholder={data ? "Choose a check and workspace" : "Loading checks…"}
            data={(data?.options ?? []).map((o) => ({
              value: JSON.stringify([o.workspace, o.check]),
              label: `${o.check} · ${o.repository} / ${o.workspace} · timeout ${duration(o.timeoutMs)}`,
            }))}
            value={selected}
            onChange={setSelected}
            disabled={!ready || !stopped || running || busy}
            style={{ flex: 1 }}
          />
          <Button disabled={!ready || !stopped || running || !option || !!error} onClick={() => setConfirm(true)}>Review check</Button>
        </Group>
        {data && !data.options.length && <Text size="sm" c="dimmed">No configured checks are available for this item.</Text>}
        {running && <Text size="sm" c="dimmed">A check is pending or running; wait for it to finish.</Text>}
      </>}
      {data?.runs.map((run) => <CheckRunCard key={run.metadata.name} run={run} />)}
      {data && !data.runs.length && <Text size="sm" c="dimmed">No check evidence has been recorded.</Text>}
    </Stack>
    <Modal opened={confirm && !!option && !pending} onClose={() => setConfirm(false)} title="Confirm standalone check">
      {option && <Stack>
        <Text>Run <b>{option.check}</b> on workspace <b>{option.workspace}</b> ({option.repository})?</Text>
        <Alert color="yellow">Configured commands may mutate the workspace and may run for a long time. The configured timeout is {duration(option.timeoutMs)}.</Alert>
        <Text size="sm">This executes the configured check. It does not change the workflow or establish approved-plan compliance.</Text>
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
          <Button loading={busy} onClick={() => void submit({ workspace: option.workspace, check: option.check, requestId: crypto.randomUUID() }, true)}>Confirm and run check</Button>
        </Group>
      </Stack>}
    </Modal>
  </Card>;
}

function CheckRunCard({ run }: { run: CheckRun }) {
  const status = run.status;
  const preparationFinished = run.spec.workflow?.purpose === "preparation" && status?.phase === "Completed" &&
    status.executionOutcome === "Passed" && !status.logsIncomplete && !!status.finalSnapshot;
  const [showLogs, setShowLogs] = useState(false);
  return <Card withBorder p="sm">
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={600} size="sm">{run.spec.check} · {run.spec.repositoryRef.name} / {run.spec.workspaceRef.name}</Text>
        <Group gap="xs">{run.spec.workflow && <Badge variant="outline">{run.spec.workflow.purpose}</Badge>}<Badge>{status?.phase ?? "Pending"}</Badge>{status?.outcome && <Badge variant="light">{status.outcome}</Badge>}</Group>
      </Group>
      <Text size="xs" c="dimmed">Run {run.metadata.name} · requested by {run.spec.requestedBy} · timeout {duration(run.spec.timeoutMs)} · duration {status?.durationMs == null ? "not available" : duration(status.durationMs)}</Text>
      <Text size="xs" style={{ overflowWrap: "anywhere" }}>Tested snapshot: {run.spec.snapshot}{status?.finalSnapshot && status.finalSnapshot !== run.spec.snapshot ? ` · final snapshot: ${status.finalSnapshot}` : ""}</Text>
      {run.spec.scope && <Text size="xs" style={{ overflowWrap: "anywhere" }}>
        Scope: {run.spec.scope.mode === "affected" ? run.spec.scope.modules.join(", ") : "full repository"} · {run.spec.scope.reason} Base: {run.spec.scope.baseCommit}
      </Text>}
      <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>{run.spec.command}</Text>
      <Text size="xs" c="dimmed">Runtime: {run.spec.environment.runtime}{run.spec.environment.version ? ` ${run.spec.environment.version}` : ""} · profile {run.spec.environment.profileVersion}{status?.exitCode != null ? ` · exit ${status.exitCode}` : ""}{status?.signal ? ` · signal ${status.signal}` : ""}</Text>
      {preparationFinished && <Alert color="yellow">Preparation command succeeded. Its resulting tree requires review; this is not final verification evidence.</Alert>}
      {status?.message && <Alert color={preparationFinished ? "yellow" : status.outcome === "Passed" ? "blue" : "red"}>{status.message}</Alert>}
      {status?.logsIncomplete && <Alert color="yellow">Log evidence is incomplete.</Alert>}
      <Button size="xs" variant="light" onClick={() => setShowLogs((value) => !value)}>{showLogs ? "Hide logs" : "View redacted logs"}</Button>
      {showLogs && <CheckLogs name={run.metadata.name} />}
    </Stack>
  </Card>;
}

function CheckLogs({ name }: { name: string }) {
  const [page, setPage] = useState<LogPage | null>(null);
  const [cursors, setCursors] = useState<number[]>([0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api<LogPage>(`/api/checks/${encodeURIComponent(name)}/logs?afterSeq=${cursor}`)
      .then((result) => { if (active) setPage(result); })
      .catch((e: unknown) => { if (active) { setPage(null); setError(errorText(e)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [name, cursor]);
  return <Stack gap="xs">
    {error && <Alert color="red">{error}</Alert>}
    {loading && <Text size="xs">Loading logs…</Text>}
    {!loading && page?.messages.length === 0 && <Text size="xs" c="dimmed">No log messages in this page.</Text>}
    {!loading && page?.messages.map((message) => <div key={message.seq}>
      <Text size="xs" c="dimmed">#{message.seq} · {message.at} · {message.author.type}:{message.author.id}</Text>
      <Text size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.content.slice(0, 16000)}{message.content.length > 16000 ? "\n[Display truncated]" : ""}</Text>
    </div>)}
    <Group>
      <Button size="xs" variant="default" disabled={loading || cursors.length === 1} onClick={() => setCursors((values) => values.slice(0, -1))}>Previous</Button>
      <Button size="xs" variant="default" disabled={loading || !page?.hasMore || page.nextAfterSeq == null} onClick={() => { if (page?.nextAfterSeq != null) setCursors((values) => [...values, page.nextAfterSeq!]); }}>Next</Button>
    </Group>
  </Stack>;
}

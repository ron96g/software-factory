/**
 * What a workflow stage of a work item is doing right now, derived from its resources (runs, checks, outbox,
 * approvals, clarifications). Pure: no React, so it is unit-testable.
 */
import type { AgentRun, CheckRun } from "@/core/model/kinds.ts";
import type { WorkItemDetail } from "@/core/ports/app.ts";

export type StageStatus = "upcoming" | "active" | "done";

export interface StageStepState {
  name: string;
  agent: string;
  run?: AgentRun;
  /** Run phase, or "not started". */
  state: string;
  detail?: string;
}

export interface StagePublication {
  repository: string;
  state: "not-configured" | "Pending" | "Delivering" | "Delivered" | "Failed" | "not-started";
  detail: string;
  url?: string;
}

export interface StageHumanInput {
  kind: "approval" | "clarification";
  name: string;
  state: string;
  detail?: string;
}

export interface StageState {
  name: string;
  status: StageStatus;
  round?: number;
  gate?: string;
  /** One line: what the stage waits for now (active stage only). */
  waitingFor?: string;
  /** Set when the stage cannot continue without a change by a human or operator. */
  needsAction?: string;
  steps: StageStepState[];
  checks: CheckRun[];
  publication: StagePublication[];
  humanInput: StageHumanInput[];
}

const SUPERSEDED = "factory.ai-dlc.io/superseded";
const roundOf = (name: string) => Number(/-r(\d+)$/.exec(name)?.[1] ?? NaN);
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const live = (r: { metadata: { labels?: Record<string, string> } }) => !r.metadata.labels?.[SUPERSEDED];

export function deriveStageState(d: WorkItemDetail, checkRuns: CheckRun[], stageName: string): StageState {
  const st = d.workItem.status;
  const stage = d.stages.find((s) => s.name === stageName);
  const index = d.stages.findIndex((s) => s.name === stageName);
  const current = d.stages.findIndex((s) => s.name === st?.stage);
  const status: StageStatus = st?.phase === "Done" || index < current ? "done" : index === current ? "active" : "upcoming";

  const runs = d.runs.filter((r) => r.spec.stage === stageName && !r.spec.replayOf && live(r));
  const checks = checkRuns.filter((c) => c.spec.workflow?.stage === stageName && live(c));
  const rounds = [...runs.map((r) => roundOf(r.metadata.name)), ...checks.map((c) => c.spec.workflow!.round)].filter((n) => !Number.isNaN(n));
  const round = status === "active" ? st?.round : rounds.length ? Math.max(...rounds) : undefined;
  const inRound = <T extends { metadata: { name: string } }>(list: T[]) => (round === undefined ? list : list.filter((x) => roundOf(x.metadata.name) === round));

  const roundRuns = inRound(runs);
  const steps: StageStepState[] = (stage?.steps ?? []).map((step) => {
    const run = roundRuns.filter((r) => r.spec.step === step.name).at(-1);
    const phase = run?.status?.phase ?? (run ? "Pending" : "not started");
    const detail = run?.status?.message ?? (run?.status?.startedAt ? `since ${time(run.status.startedAt)}` : undefined);
    return { name: step.name, agent: step.agent, run, state: phase, detail };
  });

  const roundChecks = round === undefined ? checks : checks.filter((c) => c.spec.workflow?.round === round);

  const publication: StagePublication[] = stage?.publishes ? d.repositories.map((repo) => {
    if (!repo.publishable) return { repository: repo.name, state: "not-configured" as const,
      detail: "No git remote configured for this repository: no pull request is opened; the changes stay in the workspace." };
    const msg = d.outbox.filter((m) => m.spec.action === "open-pull-request" && m.metadata.name.includes(`-${stageName}-r`) &&
      m.metadata.name.endsWith(`-pr-${repo.name}`) && (round === undefined || m.metadata.name.includes(`-${stageName}-r${round}-`))).at(-1);
    if (!msg) return { repository: repo.name, state: "not-started" as const, detail: "Not enqueued yet." };
    const s = msg.status;
    const url = typeof s?.result?.url === "string" ? s.result.url : undefined;
    const phase = s?.phase ?? "Pending";
    const detail = phase === "Delivered" ? (url ? `Pull request ${url}` : "Delivered")
      : phase === "Failed" ? `Failed after ${s?.attempts ?? 0} attempts: ${s?.lastError ?? "unknown error"}`
      : `Attempt ${s?.attempts ?? 0}${s?.nextAttemptAt ? `, next try ${time(s.nextAttemptAt)}` : ""}${s?.lastError ? ` (last error: ${s.lastError})` : ""}`;
    return { repository: repo.name, state: phase, detail, url };
  }) : [];

  const humanInput: StageHumanInput[] = [
    ...inRound(d.approvals.filter((a) => a.spec.stage === stageName)).map((a) => ({ kind: "approval" as const, name: a.metadata.name,
      state: a.spec.decision ?? (live(a) ? "pending" : "superseded"), detail: a.spec.comment })),
    ...inRound(d.clarifications.filter((c) => c.spec.stage === stageName)).map((c) => ({ kind: "clarification" as const, name: c.metadata.name,
      state: c.spec.answers?.length ? "answered" : live(c) ? "open" : "superseded", detail: c.spec.questions.join(" · ") })),
  ];

  let waitingFor: string | undefined;
  let needsAction: string | undefined;
  if (status === "active") {
    const running = roundChecks.find((c) => !c.status?.phase || c.status.phase === "Running");
    const delivering = publication.find((p) => p.state === "Pending" || p.state === "Delivering");
    const working = steps.find((s) => s.state === "Running");
    if (st?.phase === "Blocked") waitingFor = "Your answer to the open clarification.";
    else if (st?.phase === "AwaitingApproval") waitingFor = `Your decision at the ${stage?.gate ?? "approval"} gate.`;
    else if (running) waitingFor = `Check ${running.spec.check} (${running.spec.workflow?.purpose}) ${running.status?.startedAt ? `running since ${time(running.status.startedAt)}` : "queued"}.`;
    else if (delivering) waitingFor = `Pull request delivery for ${delivering.repository}: ${delivering.detail}`;
    else if (st?.phase === "Waiting") waitingFor = st.message ?? "Waiting.";
    else if (working) waitingFor = `Agent ${working.agent} is working on step ${working.name}${working.run?.status?.startedAt ? ` since ${time(working.run.status.startedAt)}` : ""}.`;
    else waitingFor = st?.message ?? "The factory is preparing the next step.";
    // Missing tools never appear by themselves: the agent definition or runtime has to change.
    if (st?.phase === "Waiting" && /not available/.test(st.message ?? "")) {
      needsAction = "This does not resolve by itself: the agent's tools are not available in this factory. Change the agent definition or the runtime, or restart the item at another stage.";
    }
    if (publication.some((p) => p.state === "Failed")) {
      needsAction ??= "A pull request could not be delivered. The stage continues without it; fix the cause and use \"Update pull request\" or restart this stage.";
    }
  }
  return { name: stageName, status, round, gate: stage?.gate, waitingFor, needsAction, steps, checks: roundChecks, publication, humanInput };
}

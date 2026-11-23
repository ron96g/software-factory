import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { ANONYMOUS as p, type PreparedWorkspace } from "../core/ports/index.ts";
import type { WorkItemDetail } from "../core/ports/app.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CITED = "web/src/core/planning/evidence.ts";
const code = (startLine: number, endLine = startLine) => ({ repository: "software-factory", path: CITED, startLine, endLine });
type Input = { name: string; resourceVersion: string; type: string };
type Message = { role: string; content?: string | null };
/** `correction` counts earlier `finish` calls in the same reviewer run. */
type Review = (inputs: Input[], correction: number) => unknown;

const review = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "2", summary: "Checked the cited code and the plan.", decisions: [], findings: [],
  verified: [{ id: "V1", claim: "currentPlanningRuns filters by owning WorkItem, not by stage.", evidence: [code(12, 17)] }], ...overrides });

async function exercise(reviewer: Review, run: (f: Factory, name: string, detail: WorkItemDetail, requests: Message[][]) => Promise<void>) {
  const reviewerRequests: Message[][] = [];
  const call = (args: unknown) => ({ id: `call-${Math.random()}`, type: "function", function: { name: "finish", arguments: JSON.stringify(args) } });
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Message[]; tools?: unknown[] };
    const user = String(body.messages.find((m) => m.role === "user")?.content ?? "");
    const step = /Stage: (\S+) · step: ([^\n]+)/.exec(user)?.[2];
    const artifacts: { type: string; content: string }[] = [];
    let outcome = step === "triage-signal" ? "accept" : undefined;
    if (step === "research-impact") artifacts.push({ type: "research-notes", content: "Unknown: whether triage runs reach upstream questions." });
    if (step === "triage-signal") artifacts.push({ type: "triage-decision", content: "outcome: accept" });
    if (step === "produce-plan") artifacts.push(
      { type: "spec", content: `AC-1: reuse planning runs. Fact: ${CITED}:12-17 selects runs by owner. See also elsewhere:lib/x.ts:1.` },
      { type: "units-of-work", content: "U1: link upstream questions." },
      { type: "implementation-plan", content: JSON.stringify({ risks: "Questions could be asked twice.", decisions: [] }) },
      { type: "validation-plan", content: JSON.stringify({
        criteria: [{ id: "AC-1", description: "Reuse planning runs", checks: ["software-factory/unit-tests"] }],
        checks: ["software-factory/build", "software-factory/unit-tests", "software-factory/integration-tests",
          "software-factory/acceptance-criteria", "software-factory/security-scan"], preflight: ["software-factory/preflight"],
        units: [{ id: "U1", title: "Link questions", dependsOn: [], criteria: ["AC-1"],
          obligations: [{ id: "U1-O1", description: "Link upstream questions", checks: ["software-factory/unit-tests"] }] }],
      }) },
    );
    if (step === "ai-plan-review") {
      reviewerRequests.push(body.messages);
      const marker = "## Required JSON contract: planning-review (from artifact-schema:planning-review)\n";
      const contract: { inputs: Input[] } = JSON.parse(user.slice(user.indexOf(marker) + marker.length).split("\n\n## ")[0]);
      const document = reviewer(contract.inputs, body.messages.filter((m) => m.role === "tool").length) as { findings: { kind: string }[] };
      artifacts.push({ type: "planning-review", content: JSON.stringify(document) });
      outcome = document.findings.some((finding) => finding.kind !== "advisory") ? "changes-requested" : "approve";
    }
    const result = { summary: "Test step", artifacts, outcome, questions: [] };
    if (body.tools) return Response.json({ choices: [{ message: { content: null, tool_calls: [call(result)] } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  };
  const backend = {
    supports: () => true, sweep: async () => [], remove: async () => {},
    prepare: async (): Promise<PreparedWorkspace> => ({ path: ROOT, baseCommit: "c0ffee", headCommit: "c0ffee", preparedBy: "fake", setupCompleted: true }),
  };
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_AGENT_RUNTIME: "tool-loop", FACTORY_SANDBOX_RUNTIME: "none", OPENAI_API_KEY: "test-grounded-key", FACTORY_SIMULATION: "wait" },
    fetch: fetchImpl, workspaceBackend: backend, log: () => {} });
  await f.start();
  try {
    const item = await f.app.createWorkItem(p, { title: "Grounded plan review", description: "Stop asking the same planning question twice." });
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = (await f.app.getWorkItem(p, item.metadata.name))!;
      if (["Failed", "AwaitingApproval"].includes(detail.workItem.status?.phase ?? "")) {
        return await run(f, item.metadata.name, detail, reviewerRequests);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.fail(`Review did not stop: ${JSON.stringify((await f.app.getWorkItem(p, item.metadata.name))?.workItem.status)}`);
  } finally { await f.stop(); }
}

const reviewRuns = (detail: WorkItemDetail) => detail.runs.filter((r) => r.spec.step === "ai-plan-review");

test("AC-37-1: cited code and a tool guide reach the reviewer before its first step; checked claims are shown, not raised", async () => {
  await exercise(() => review(), async (f, name, detail, requests) => {
    assert.equal(detail.workItem.status?.phase, "AwaitingApproval", detail.workItem.status?.message ?? "");
    const [first] = requests;
    const system = String(first.find((m) => m.role === "system")?.content);
    const user = String(first.find((m) => m.role === "user")?.content);
    assert.match(system, /## Tools for this run\nWorkspaces \(pinned commits\): software-factory@c0ffee/);
    assert.match(system, /- `read_file`: Check the code behind a claim/);
    assert.ok(!/`write_file`/.test(system), "only tools bound for this run are explained");
    assert.match(user, /Cited code \(pinned workspace\)/);
    assert.match(user, / {3}12\| export function currentPlanningRuns/, "the cited lines arrive without a tool call");
    assert.match(user, /elsewhere:lib\/x\.ts:1: not-readable/);
    const [run] = reviewRuns(detail);
    assert.equal(run.status?.provenance?.contextCounts?.["cited-code"]?.resolved, 1);
    assert.equal(run.status?.provenance?.toolUse?.finishCorrections, 0);
    const workspace = await f.planning.inspect(p, name);
    assert.equal(workspace.readiness, "ready", workspace.issues.join("; "));
    assert.deepEqual(workspace.review?.verified?.[0].evidence, [code(12, 17)]);
  });
});

test("AC-37-2: output mistakes are corrected inside the producing run, without a rerun", async () => {
  await exercise((inputs, correction) => {
    const spec = inputs.find((input) => input.type === "spec")!;
    if (correction === 0) return review({ findings: [{ id: "F1", kind: "research-gap", summary: "Unverified run selection.",
      claim: "Triage runs reach upstream questions.", evidence: [{ artifact: { name: spec.name, resourceVersion: spec.resourceVersion } }],
      investigation: { checked: [], searches: [], unresolvedBecause: "Not checked." } }] });
    if (correction === 1) return review({ verified: [{ id: "V1", claim: "Selection by owner.", evidence: [code(9000, 9001)] }] });
    return review();
  }, async (f, name, detail) => {
    assert.equal(detail.workItem.status?.phase, "AwaitingApproval", detail.workItem.status?.message ?? "");
    const runs = reviewRuns(detail);
    assert.equal(runs.length, 1, "no post-run rejection, no new run");
    assert.ok(!detail.events.some((event) => event.spec.reason === "OutputRejected"));
    assert.equal(runs[0].status?.provenance?.toolUse?.finishCorrections, 2);
    const transcript = await f.app.runTranscript(p, runs[0].metadata.name);
    const rejections = transcript.filter((m) => m.role === "tool-result" && m.meta?.tool === "finish").map((m) => m.content);
    assert.match(rejections[0], /Research gap F1 must say what you investigated/);
    assert.match(rejections[1], /web\/src\/core\/planning\/evidence\.ts:9000-9001 is out of range; the file has \d+ lines/);
    assert.equal((await f.planning.inspect(p, name)).readiness, "ready");
  });
});

test("AC-37-3: when in-loop corrections run out, post-run checks still reject and only the reviewer reruns", async () => {
  await exercise(() => review({ verified: [{ id: "V1", claim: "Selection by owner.", evidence: [{ ...code(1), repository: "elsewhere" }] }] }),
    async (f, name, detail) => {
      assert.equal(detail.workItem.status?.phase, "Failed");
      assert.match(detail.workItem.status?.message ?? "", /repository "elsewhere" is not one of this run's workspaces/);
      assert.equal(reviewRuns(detail).length, 3, "bounded producer-only reruns");
      assert.equal(detail.runs.filter((r) => r.spec.step === "produce-plan").length, 1);
      assert.ok(reviewRuns(detail).every((run) => run.status?.provenance?.toolUse?.finishCorrections === 2));
      assert.equal((await f.planning.inspect(p, name)).readiness, "needs-agent-repair");
    });
});

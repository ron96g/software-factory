import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { deriveGateEvidence, parseVerdict } from "./app/gate-evidence.ts";
import { createFactory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";
import type { AgentRun, FactoryEvent } from "./model/kinds.ts";
import { InMemorySandboxEnvironment } from "./adapters/sandbox/basic.ts";

const run = (name: string, step: string, outcome: string, outcomes = ["pass", "partial", "fail"]): AgentRun =>
  ({
    kind: "AgentRun",
    metadata: { name },
    spec: { stage: "verify", step, agentRef: { name: "verifier" }, outcomes },
    status: { phase: "Succeeded", result: { outcome, summary: `${outcome}!` } },
  }) as unknown as AgentRun;
const ev = (reason: string, message: string, t: string): FactoryEvent =>
  ({ kind: "Event", metadata: { name: t, creationTimestamp: t }, spec: { reason, message, type: reason === "CheckFailed" ? "Warning" : "Normal" } }) as unknown as FactoryEvent;

test("X5: verdicts stated only in text count (older runs / agents ignoring the outcome field)", () => {
  assert.equal(parseVerdict("Verdict: FAIL (coverage)\nThe spec's quality gate…"), "fail");
  assert.equal(parseVerdict("**Verdict:** partial"), "partial");
  assert.equal(parseVerdict("so the verdict is FAIL on coverage."), "fail");
  assert.equal(parseVerdict("## Verdict\n\n**PASS**"), "pass");
  assert.equal(parseVerdict("all good"), undefined);
  const legacy = { kind: "AgentRun", metadata: { name: "x-verify-0-r7" }, spec: { stage: "verify", step: "verify-against-spec", agentRef: { name: "verifier" } }, status: { phase: "Succeeded", result: { summary: "Verification: tsc is clean. The verdict is FAIL on coverage." } } } as unknown as AgentRun;
  const e = deriveGateEvidence({ runs: [legacy], events: [], clarifications: [] });
  assert.equal(e.status, "blocking");
  assert.match(e.items[0].label, /fail \(from report text\)/);
});

test("X5: failures recorded before the latest code change are downgraded (stale)", () => {
  const dev = { kind: "AgentRun", metadata: { name: "x-implement-0-r6" }, spec: { stage: "implement", step: "write-code", agentRef: { name: "developer" }, outputs: [{ name: "source-code" }] }, status: { phase: "Succeeded", finishedAt: "2026-01-01T00:00:05Z" } } as unknown as AgentRun;
  const e = deriveGateEvidence({ runs: [dev], events: [ev("CheckFailed", "build on repo: exit 1", "2026-01-01T00:00:01Z")], clarifications: [] });
  assert.equal(e.status, "warning");
  assert.match(e.items[0].label, /outdated: code changed since/);
});

test("verified migration keeps historical check/loop events out of current gate blockers without hiding fresh failures", () => {
  const input = {
    runs: [],
    clarifications: [],
    events: [
      ev("CheckFailed", "build on repo: exit 137", "2026-01-01T00:00:01Z"),
      ev("LoopExhausted", "old code-review loop exhausted", "2026-01-01T00:00:02Z"),
      ev("Restarted", "validation planning", "2026-01-01T00:00:03Z"),
    ],
  };
  assert.equal(deriveGateEvidence(input).status, "blocking", "legacy behavior is unchanged");
  assert.deepEqual(deriveGateEvidence({ ...input, verified: true }), { status: "ok", items: [] });
  const current = deriveGateEvidence({ ...input, verified: true,
    runs: [run("x-spec-review-0-r22", "review", "fail")],
    events: [...input.events, ev("CheckFailed", "tests on repo: exit 1", "2026-01-01T00:00:04Z")] });
  assert.equal(current.status, "blocking");
  assert.ok(current.items.some((item) => item.label === "Check: tests failed"));
  assert.ok(current.items.some((item) => item.runName === "x-spec-review-0-r22"));
  assert.ok(!current.items.some((item) => /build|loop exhausted/.test(item.label)));
});

test("X5: evidence uses the latest round per step; a later passing check clears an earlier failure", () => {
  const e = deriveGateEvidence({
    runs: [run("x-verify-0-r5", "verify-against-spec", "fail"), run("x-verify-0-r7", "verify-against-spec", "pass")],
    events: [ev("CheckFailed", "build on repo: exit 1", "2026-01-01T00:00:01Z"), ev("CheckPassed", "build on repo: exit 0", "2026-01-01T00:00:02Z")],
    clarifications: [],
  });
  assert.equal(e.status, "ok");
  const f = deriveGateEvidence({ runs: [run("x-verify-0-r7", "verify-against-spec", "fail")], events: [], clarifications: [] });
  assert.equal(f.status, "blocking");
  assert.match(f.items[0].label, /verify-against-spec: fail/);
  const p = deriveGateEvidence({ runs: [run("x-verify-0-r7", "verify-against-spec", "partial")], events: [ev("CheckFailed", "unit-tests on repo: exit 2", "t")], clarifications: [] });
  assert.equal(p.status, "blocking");
  assert.deepEqual(p.items.map((i) => i.severity), ["blocking", "warning"]);
});

test("X5: a failed verification can't be approved by accident (server-enforced override with reason)", async () => {
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const system = String(body.messages[0].content);
    if (body.tools) {
      // tool-loop agents (developer, verifier) finish immediately; the verifier reports a failing verdict
      const args = system.includes("## Skill: verification")
        ? { summary: "Acceptance criterion 2 violated", outcome: "fail", artifacts: [{ type: "verification-report", content: "**Verdict: FAIL**" }] }
        : { summary: "done" };
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "f", type: "function", function: { name: "finish", arguments: JSON.stringify(args) } }] } }] });
    }
    const out = system.includes("## Skill: verification")
      ? { summary: "Acceptance criterion 2 violated", outcome: "fail", artifacts: [{ type: "verification-report", content: "**Verdict: FAIL**" }], questions: [] }
      : { summary: "ok", outcome: system.includes("## Skill: code-review") ? "approve" : "accept", artifacts: [], questions: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }) as typeof fetch;
  const f = await createFactory({ definitionsRoot: resolve(import.meta.dirname, "../../.."), databasePath: ":memory:", env: { OPENAI_API_KEY: "sk-test-123456", FACTORY_SANDBOX_RUNTIME: "in-memory" }, fetch: fetchImpl, sandboxes: [new InMemorySandboxEnvironment()], log: () => {} });
  await f.start();
  const p = ANONYMOUS;
  try {
    const wi = await f.app.createWorkItem(p, { title: "Guarded release", description: "A long enough description for triage to accept it directly." });
    let d = null;
    for (let i = 0; i < 1000; i++) {
      d = (await f.app.getWorkItem(p, wi.metadata.name))!;
      const st = d.workItem.status;
      if (st?.phase === "AwaitingApproval" && st.stage === "ship") break;
      if (st?.phase === "AwaitingApproval") await f.app.decideApproval(p, d.approvals.find((a) => !a.spec.decision)!.metadata.name, "approve");
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(d!.evidence.status, "blocking");
    assert.ok(d!.evidence.items.some((i) => /verify-against-spec: fail/.test(i.label)));
    const ship = d!.approvals.find((a) => !a.spec.decision)!.metadata.name;
    await assert.rejects(f.app.decideApproval(p, ship, "approve"), /blocking evidence .*requires an explicit override/);
    await assert.rejects(f.app.decideApproval(p, ship, "approve", "ok", true), /at least 10 characters/);
    await f.app.decideApproval(p, ship, "approve", "Hotfix accepted by the product owner", true);
    const after = (await f.app.getWorkItem(p, wi.metadata.name))!;
    assert.ok(after.events.some((e) => e.spec.reason === "ApprovedDespiteFailures" && /Hotfix accepted/.test(e.spec.message)));
    assert.equal(after.approvals.find((a) => a.metadata.name === ship)?.spec.overridden, true);
  } finally {
    await f.stop();
  }
});

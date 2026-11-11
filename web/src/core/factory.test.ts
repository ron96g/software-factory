import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { ANONYMOUS } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

async function withFactory(env: Record<string, string>, fn: (f: Factory) => Promise<void>, fetchImpl?: typeof fetch) {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env, fetch: fetchImpl, log: () => {} });
  await f.start();
  try {
    await fn(f);
  } finally {
    await f.stop();
  }
}

const p = ANONYMOUS;

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const phaseIs = (f: Factory, name: string, phase: string) => async () => {
  const d = await f.app.getWorkItem(p, name);
  return d?.workItem.status?.phase === phase ? d : undefined;
};

test("M2/M3: full loop on simulated executor incl. block/answer, reject/approve, research notes", async () => {
  await withFactory({}, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Transcript store redaction", description: "short" });
    assert.equal(wi.spec.workflowRef?.name, "factory-loop");

    // classify → triage (research + thin description) → Blocked
    let d = await waitFor(phaseIs(f, wi.metadata.name, "Blocked"), "Blocked");
    assert.equal(d.workItem.status?.stage, "triage");
    assert.ok(d.workItem.status?.classification?.type, "classified");
    const notes = d.artifacts.find((a) => a.spec.artifactTypeRef.name === "research-notes");
    assert.ok(notes, "research notes attached");
    assert.match(notes.spec.content, /software-factory:web\/src\/[^:]+:\d+/, "cites repo:path:line");
    const clar = d.clarifications[0];
    assert.equal(clar.spec.questions.length, 2);

    // every run has a transcript
    for (const r of d.runs.filter((r) => r.status?.phase === "Succeeded")) {
      assert.ok((await f.app.runTranscript(p, r.metadata.name)).length > 0, `${r.metadata.name} has transcript`);
    }

    // answer → resume triage (new round) → spec → spec-review approval
    await f.app.answerClarification(p, clar.metadata.name, ["Secrets must never appear in transcripts", "Everyone, P1"]);
    d = await waitFor(phaseIs(f, wi.metadata.name, "AwaitingApproval"), "spec-review approval");
    assert.equal(d.workItem.status?.stage, "spec-review");
    assert.ok(d.artifacts.some((a) => a.spec.artifactTypeRef.name === "spec"));
    assert.ok(d.events.some((e) => e.spec.reason === "Resumed"));

    // reject → back to spec → approve
    await f.app.decideApproval(p, d.approvals.at(-1)!.metadata.name, "reject", "needs NFRs");
    d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      return x?.workItem.status?.phase === "AwaitingApproval" && x.approvals.length === 2 ? x : undefined;
    }, "second spec-review");
    await f.app.decideApproval(p, d.approvals.find((a) => !a.spec.decision)!.metadata.name, "approve");

    // code-review, ship approvals
    for (const stage of ["code-review", "ship"]) {
      d = await waitFor(async () => {
        const x = await f.app.getWorkItem(p, wi.metadata.name);
        return x?.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.stage === stage ? x : undefined;
      }, stage);
      await f.app.decideApproval(p, d.approvals.find((a) => !a.spec.decision)!.metadata.name, "approve");
    }
    d = await waitFor(phaseIs(f, wi.metadata.name, "Done"), "Done");
    assert.ok(d.events.some((e) => e.spec.reason === "CheckNotImplemented"), "automated checks pass with warning");
    assert.deepEqual(d.stages.map((s) => s.name), ["classify", "triage", "spec", "spec-review", "design", "implement", "code-review", "verify", "ship", "monitor"]);
  });
});

test("M3: explain-mode conversation without LLM is grounded in the transcript and side-effect free", async () => {
  await withFactory({}, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Add dark mode", description: "x" });
    const d = await waitFor(phaseIs(f, wi.metadata.name, "Blocked"), "Blocked");
    const triageRun = d.runs.find((r) => r.spec.step === "triage-signal")!;
    const conv = await f.app.startConversation(p, triageRun.metadata.name);
    const answer = await f.app.sendMessage(p, conv.metadata.name, "Why did you ask for more info?");
    assert.equal(answer.role, "assistant");
    assert.match(answer.content, /description is too thin/);
    const msgs = await f.app.conversationMessages(p, conv.metadata.name);
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
    const after = await f.app.getWorkItem(p, wi.metadata.name);
    assert.equal(after?.workItem.status?.phase, "Blocked");
    assert.equal(after?.workItem.metadata.resourceVersion !== undefined, true);
  });
});

test("M3: LLM executor via OpenAI-compatible provider; secret redacted; provenance recorded", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init.body));
    const sys: string = body.messages[0].content;
    const result = sys.includes("Triager Agent")
      ? { summary: "Clear enough (key sk-test-123456 leaked?)", outcome: "accept", questions: [], classification: { type: "bug", priority: "P2" } }
      : { summary: "done", artifacts: [], questions: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }) as typeof fetch;
  await withFactory(
    { OPENAI_API_KEY: "sk-test-123456" },
    async (f) => {
      const wi = await f.app.createWorkItem(p, { title: "Crash on save", description: "The app crashes with an exception when saving a work item." });
      const d = await waitFor(async () => {
        const x = await f.app.getWorkItem(p, wi.metadata.name);
        return x?.workItem.status?.stage === "spec" || x?.workItem.status?.phase === "AwaitingApproval" ? x : undefined;
      }, "past triage");
      const triage = d.runs.find((r) => r.spec.step === "triage-signal")!;
      assert.equal(triage.status?.provenance?.executor, "llm");
      assert.equal(triage.status?.provenance?.model?.name, "gpt-5.1");
      assert.ok(triage.status?.provenance?.promptHash);
      const t = await f.app.runTranscript(p, triage.metadata.name);
      const assistant = t.find((m) => m.role === "assistant")!;
      assert.ok(!assistant.content.includes("sk-test-123456"), "secret redacted");
      assert.ok(calls.every((u) => u.startsWith("https://api.openai.com/v1/chat/completions")));
      // developer agent needs shell → stays simulated (ADR-0016)
    },
    fakeFetch,
  );
});

test("M4: GitHub sync imports issues as WorkItems (idempotent)", async () => {
  const fakeFetch = (async (url: string) => {
    assert.match(String(url), /repos\/ron96g\/software-factory\/issues\?state=open.*labels=factory/);
    return new Response(
      JSON.stringify([
        { number: 7, html_url: "https://github.com/acme/shop/issues/7", title: "Login broken", body: "500 on login", labels: [{ name: "factory" }], updated_at: "t1" },
        { number: 8, html_url: "x", title: "PR", body: "", labels: [], updated_at: "t1", pull_request: {} },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
  await withFactory(
    {},
    async (f) => {
      assert.deepEqual(await f.app.syncSource(p, "github-issues"), { created: 1, updated: 0 });
      assert.deepEqual(await f.app.syncSource(p, "github-issues"), { created: 0, updated: 0 });
      const items = await f.app.listWorkItems(p);
      assert.equal(items[0].metadata.name, "github-issues-7");
      assert.equal(items[0].spec.externalRef?.url, "https://github.com/acme/shop/issues/7");
      assert.equal(items[0].spec.repositoryRefs?.[0].name, "software-factory");
    },
    fakeFetch,
  );
});

test("ADR-0028: a provider's agentModels override the tier mapping for that agent only", async () => {
  const { DefaultModelResolver } = await import("./agents/model-resolver.ts");
  const provider = { kind: "ModelProvider", metadata: { name: "p", namespace: "factory-system" }, spec: { type: "t", models: { reasoning: "big", fast: "small" }, agentModels: { developer: "coder-x" } } };
  const reader = { list: async () => [provider], get: async () => provider } as never;
  const r = new DefaultModelResolver(reader, { resolve: () => undefined } as never, { get: () => ({ create: () => ({}) }) } as never);
  const dev = await r.resolve({ namespace: "default", tier: "reasoning", agent: "developer" });
  const po = await r.resolve({ namespace: "default", tier: "reasoning", agent: "product-owner" });
  assert.equal(dev?.model, "coder-x");
  assert.equal(dev?.selectedBy, "agent");
  assert.equal(po?.model, "big");
  assert.equal(po?.selectedBy, "tier");
});

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

test("restart from a stage: new round, earlier output of restarted stages superseded and not used as input", async () => {
  await withFactory({}, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Restart me", description: "A description long enough that triage does not ask questions." });
    const before = await waitFor(phaseIs(f, wi.metadata.name, "AwaitingApproval"), "spec-review");
    const oldSpec = before.artifacts.find((a) => a.spec.artifactTypeRef.name === "spec")!;
    const oldNotes = before.artifacts.find((a) => a.spec.artifactTypeRef.name === "research-notes")!;

    await f.app.restartWorkItem(p, wi.metadata.name, "spec");
    const after = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      return x?.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.blockedBy?.name !== before.workItem.status?.blockedBy?.name ? x : undefined;
    }, "spec-review after restart");

    assert.ok(after.events.some((e) => e.spec.reason === "Restarted"));
    assert.ok(after.workItem.status!.round! > before.workItem.status!.round!);
    await assert.rejects(f.app.decideApproval(p, before.workItem.status!.blockedBy!.name, "approve"), /no longer open/, "old round's approval is inert");
    const label = (n: string) => after.artifacts.find((a) => a.metadata.name === n)?.metadata.labels?.["factory.ai-dlc.io/superseded"];
    assert.ok(label(oldSpec.metadata.name), "spec from before the restart is superseded");
    assert.equal(label(oldNotes.metadata.name), undefined, "triage output (before the restart stage) stays current");
    const newSpecRun = after.runs.find((r) => r.spec.step === before.runs.find((x) => x.metadata.name === oldSpec.spec.producedBy!.agentRunRef.name)!.spec.step && !r.metadata.labels?.["factory.ai-dlc.io/superseded"])!;
    assert.notEqual(newSpecRun.metadata.name, oldSpec.spec.producedBy!.agentRunRef.name);
    const superseded = new Set(after.artifacts.filter((a) => a.metadata.labels?.["factory.ai-dlc.io/superseded"]).map((a) => a.metadata.name));
    assert.ok(Object.keys(newSpecRun.status!.provenance!.inputs).every((n) => !superseded.has(n)), "no superseded inputs");
  });
});

test("restart revives a finished item; unknown stages are rejected", async () => {
  await withFactory({}, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Done then restarted", description: "A description long enough that triage does not ask questions." });
    await assert.rejects(f.app.restartWorkItem(p, wi.metadata.name, "nope"), /stage "nope" not found/);
    for (const stage of ["spec-review", "code-review", "ship"]) {
      const d = await waitFor(async () => {
        const x = await f.app.getWorkItem(p, wi.metadata.name);
        return x?.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.stage === stage ? x : undefined;
      }, stage);
      await f.app.decideApproval(p, d.approvals.find((a) => !a.spec.decision)!.metadata.name, "approve");
    }
    await waitFor(phaseIs(f, wi.metadata.name, "Done"), "Done");

    await f.app.restartWorkItem(p, wi.metadata.name);
    const x = await waitFor(async () => {
      const y = await f.app.getWorkItem(p, wi.metadata.name);
      return y?.workItem.status?.restartHandled && y.workItem.status.phase === "AwaitingApproval" ? y : undefined;
    }, "restarted from the beginning");
    assert.equal(x.workItem.status?.stage, "spec-review");
    assert.ok(x.events.some((e) => e.spec.reason === "Restarted" && /from classify/.test(e.spec.message ?? "")));
  });
});

test("FACTORY_SIMULATION=wait: runs without a real executor wait instead of producing placeholders", async () => {
  await withFactory({ FACTORY_SIMULATION: "wait" }, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Wait for an LLM", description: "A description long enough that triage does not ask questions." });
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      return x?.runs.some((r) => r.status?.phase === "Pending" && /Waiting instead of simulating/.test(r.status.message ?? "")) ? x : undefined;
    }, "a waiting run");
    const waiting = d.runs.find((r) => r.status?.phase === "Pending")!;
    assert.equal(waiting.spec.step, "triage-signal", "deterministic skill handlers still run; the first LLM-only step waits");
    assert.ok(d.runs.find((r) => r.spec.step === "auto-classify")?.status?.phase === "Succeeded");
    assert.ok(!d.artifacts.some((a) => /\(simulated\)/.test(a.spec.content)), "no placeholder artifacts");
    const item = await waitFor(phaseIs(f, wi.metadata.name, "Waiting"), "item shows Waiting");
    assert.match(item.workItem.status?.message ?? "", /Waiting instead of simulating/);
    assert.equal((await f.app.systemHealth(p)).simulation, "wait");
  });
});

test("servicedesk workflow: response review rejects/redrafts, then a fresh publication review prevents automatic ticket writes", async () => {
  const writes: string[] = [];
  let updated = "2026-11-12T10:00:00.000+0000";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if ((init?.method ?? "GET") !== "GET") writes.push(u.pathname);
    if (u.pathname === "/rest/api/2/search") {
      return Response.json({
        issues: [{ key: "DESK-1", self: "x", fields: { summary: "Route returns 404", description: "Our API route in the prod environment returns 404 since yesterday's deployment.", labels: ["factory"], updated } }],
      });
    }
    return Response.json({ comments: [] });
  }) as typeof fetch;

  await withFactory({}, async (f) => {
    assert.deepEqual(await f.app.syncSource(p, "jira-servicedesk"), { created: 1, updated: 0 });
    const name = "jira-servicedesk-desk-1";
    let d = await waitFor(phaseIs(f, name, "AwaitingApproval"), "response-review");
    assert.equal(d.workItem.spec.workflowRef?.name, "servicedesk");
    assert.deepEqual(d.stages.map((s) => s.name), ["classify", "investigate", "respond", "response-review", "publish-response"]);
    assert.equal(d.workItem.status?.stage, "response-review");
    for (const t of ["research-notes", "support-analysis", "customer-response"]) assert.ok(d.artifacts.some((a) => a.spec.artifactTypeRef.name === t), t);

    await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "reject", "Mention the workaround first");
    d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.workItem.status?.phase === "AwaitingApproval" && x.approvals.length === 2 ? x : undefined;
    }, "second review");
    assert.equal(d.artifacts.filter((a) => a.spec.artifactTypeRef.name === "customer-response").length, 2, "redrafted");
    await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "approve");
    await waitFor(async () => {
      const x = await f.app.getWorkItem(p, name);
      return x?.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.stage === "publish-response" ? x : undefined;
    }, "fresh publication review");

    // Human context survives a re-sync that updates title/description (sync writes only what it owns).
    await f.app.updateWorkItemContext(p, name, "Customer uses the Rover CLI in eu-central.");
    updated = "2026-11-12T11:00:00.000+0000";
    assert.deepEqual(await f.app.syncSource(p, "jira-servicedesk"), { created: 0, updated: 1 });
    assert.equal((await f.app.getWorkItem(p, name))?.workItem.spec.context, "Customer uses the Rover CLI in eu-central.");
    assert.deepEqual(writes, [], "read-only source: nothing was written to Jira");
  }, fetchImpl);
});

test("new item: offers top-level workflows and readable repositories, applies the picks, rejects unusable ones", async () => {
  await withFactory({}, async (f) => {
    const o = await f.app.newItemOptions(p);
    const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();
    assert.ok(names(o.workflows).includes("servicedesk") && names(o.workflows).includes("factory-loop"));
    assert.ok(!names(o.workflows).includes("construction-bolt"), "sub-workflows are not offered");
    assert.ok(names(o.repositories).includes("software-factory"));
    assert.ok(!names(o.repositories).includes("shop-backend"), "no local checkout, not offered");
    assert.deepEqual(o.defaults, { workflow: "factory-loop", repositories: ["software-factory"] });

    const wi = await f.app.createWorkItem(p, { title: "Picked", description: "x", workflowRef: "servicedesk", repositoryRefs: ["software-factory"] });
    assert.equal(wi.spec.workflowRef?.name, "servicedesk");
    assert.deepEqual(wi.spec.repositoryRefs?.map((r) => r.name), ["software-factory"]);
    assert.equal((await f.app.createWorkItem(p, { title: "Defaults" })).spec.workflowRef?.name, "factory-loop");

    await assert.rejects(f.app.createWorkItem(p, { title: "x", workflowRef: "construction-bolt" }), /can't be used for a new item/);
    await assert.rejects(f.app.createWorkItem(p, { title: "x", repositoryRefs: ["shop-backend"] }), /without a local checkout/);
  });
});

test("model quota / rate limit (HTTP 429): the run waits and retries instead of failing the item", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("quota exceeded", { status: 429, headers: { "retry-after": "1" } });
    if (calls === 2) return new Response("quota exceeded", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  }) as typeof fetch;
  await withFactory({ OPENAI_API_KEY: "sk-test-123456" }, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Survive a quota error", description: "A description long enough that triage does not ask questions." });
    const waiting = await waitFor(phaseIs(f, wi.metadata.name, "Waiting"), "item shows Waiting");
    assert.match(waiting.workItem.status?.message ?? "", /Waiting for the model: LLM HTTP 429/);
    const d = await waitFor(async () => {
      const x = await f.app.getWorkItem(p, wi.metadata.name);
      return x?.runs.find((r) => r.spec.step === "auto-classify")?.status?.phase === "Succeeded" ? x : undefined;
    }, "classify succeeded after waiting");
    const run = d.runs.find((r) => r.spec.step === "auto-classify")!;
    assert.notEqual(d.workItem.status?.phase, "Failed");
    assert.ok(d.events.some((e) => e.spec.reason === "ModelUnavailable" && /429/.test(e.spec.message ?? "")), "visible once as a warning");
    assert.equal(d.events.filter((e) => e.spec.reason === "ModelUnavailable").length, 1, "warned once, not per retry");
    const t = await f.app.runTranscript(p, run.metadata.name);
    assert.ok(t.filter((m) => m.role === "note" && /model unavailable/.test(m.content)).length >= 2, "each wait is recorded in the same transcript");
    assert.equal(run.status?.modelWaits, undefined, "cleared on success");
    const done = await waitFor(phaseIs(f, wi.metadata.name, "AwaitingApproval"), "item continues normally");
    assert.equal(done.events.filter((e) => e.spec.reason === "Waiting" && e.spec.involvedObject.kind === "WorkItem").length, 1, "one Waiting event, no flicker");
  }, fetchImpl);
});

test("model quota: Retry-After is capped, and a restart (e.g. with a new token) retries right away", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const db = join(mkdtempSync(join(tmpdir(), "sf-quota-")), "factory.db");
  const exhausted = (async () => new Response("quota exceeded", { status: 429, headers: { "retry-after": "1209600" } })) as typeof fetch;
  const ok = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] })) as typeof fetch;
  const open = (fetchImpl: typeof fetch) => createFactory({ definitionsRoot: ROOT, databasePath: db, env: { OPENAI_API_KEY: "sk-test-123456" }, fetch: fetchImpl, log: () => {} });

  let f = await open(exhausted);
  await f.start();
  const wi = await f.app.createWorkItem(p, { title: "Quota then new token", description: "A description long enough that triage does not ask questions." });
  const waiting = await waitFor(phaseIs(f, wi.metadata.name, "Waiting"), "waiting");
  const run = waiting.runs.find((r) => r.status?.phase === "Pending")!;
  assert.ok(Date.parse(run.status!.retryAt!) - Date.now() <= 15 * 60_000 + 1000, "two weeks of Retry-After capped to 15 minutes");
  await f.stop();

  f = await open(ok);
  await f.start();
  try {
    await waitFor(phaseIs(f, wi.metadata.name, "AwaitingApproval"), "continues right after the restart");
  } finally {
    await f.stop();
  }
});

test("additional context: every agent prompt carries it, so agents don't ask for it", async () => {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    prompts.push(body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], outcome: "accept", questions: [] }) } }] });
  }) as typeof fetch;
  await withFactory({ OPENAI_API_KEY: "sk-test-123456" }, async (f) => {
    const wi = await f.app.createWorkItem(p, { title: "Context please", description: "A description long enough that triage does not ask questions.", context: "Environment: prod, eu-central." });
    assert.equal(wi.spec.context, "Environment: prod, eu-central.");
    await waitFor(phaseIs(f, wi.metadata.name, "AwaitingApproval"), "spec-review");
    assert.ok(prompts.length > 2 && prompts.every((u) => u.includes("## Additional context from the team") && u.includes("Environment: prod, eu-central.")));
    await f.app.updateWorkItemContext(p, wi.metadata.name, "");
    assert.equal((await f.app.getWorkItem(p, wi.metadata.name))?.workItem.spec.context, undefined, "clearing removes it");
  }, fetchImpl);
});

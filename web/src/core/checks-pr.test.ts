import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { InMemorySandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { ANONYMOUS, type PreparedWorkspace } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(buildResults: number[]) {
  const commands: string[] = [];
  let builds = 0;
  const sandbox = new InMemorySandboxEnvironment({
    handlers: [
      (cmd) => {
        commands.push(cmd);
        if (cmd.includes("tsc")) return { exitCode: buildResults[Math.min(builds++, buildResults.length - 1)], stdout: "tsc output", stderr: "" };
        if (cmd.includes("npm test")) return { exitCode: 0, stdout: "29 passing" };
        return undefined;
      },
    ],
  });
  const published: string[] = [];
  const prs: { head: string; base: string; title: string; body: string; draft: boolean }[] = [];
  const backend = {
    supports: () => true,
    sweep: async () => [],
    remove: async () => {},
    prepare: async (): Promise<PreparedWorkspace> => ({ path: ROOT, baseCommit: "base123", headCommit: "base123", preparedBy: "fake", setupCompleted: true }),
  };
  return {
    commands,
    published,
    prs,
    make: () =>
      createFactory({
        definitionsRoot: ROOT,
        databasePath: ":memory:",
        env: { FACTORY_SANDBOX_RUNTIME: "in-memory" },
        sandboxes: [sandbox],
        workspaceBackend: backend,
        checkPollMs: 20,
        publisher: { publish: async (ws) => (published.push(ws.metadata.name), { branch: ws.spec.branch, commit: "head456", pushed: true }) },
        codeHosts: [
          {
            type: "github",
            matches: () => true,
            openPullRequest: async (_repo, input) => (prs.push(input), { url: "https://github.com/ron96g/software-factory/pull/1", number: 1, created: true }),
          },
        ],
        log: () => {},
      }),
  };
}

async function drive(f: Factory, name: string, until: (d: NonNullable<Awaited<ReturnType<Factory["app"]["getWorkItem"]>>>) => boolean) {
  for (let i = 0; i < 1000; i++) {
    const d = (await f.app.getWorkItem(p, name))!;
    if (until(d)) return d;
    if (d.workItem.status?.phase === "AwaitingApproval" && d.workItem.status.stage !== "ship") {
      const open = d.approvals.find((a) => !a.spec.decision);
      if (open) await f.app.decideApproval(p, open.metadata.name, "approve");
    }
    await sleep(15);
  }
  const d = (await f.app.getWorkItem(p, name))!;
  throw new Error(`timeout: ${JSON.stringify(d.workItem.status)} outbox=${JSON.stringify(d.outbox.map((m) => [m.spec.action, m.status]))} events=${d.events.slice(-6).map((e) => e.spec.reason + ":" + e.spec.message.slice(0, 120)).join(" | ")}`);
}

test("S5c: real checks run in the workspace (fail → retry implement → pass), then a draft PR is opened via the outbox", async () => {
  const s = setup([1, 0]); // first build fails, second passes
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Checks and PR", description: "A long enough description for triage to accept it directly." });
    const d = await drive(f, wi.metadata.name, (x) => x.outbox.some((m) => m.status?.phase === "Delivered"));
    assert.equal(d.workItem.status?.retries?.verify, 1, "one failed attempt consumed the retry budget");
    assert.ok(d.events.some((e) => e.spec.reason === "CheckFailed" && /build/.test(e.spec.message)));
    assert.ok(d.events.some((e) => e.spec.reason === "CheckPassed" && /unit-tests/.test(e.spec.message)));
    assert.ok(d.events.some((e) => e.spec.reason === "CheckNotImplemented" && /security-scan/.test(e.spec.message)));
    assert.ok(s.commands.filter((c) => c.includes("tsc")).length >= 2);
    assert.ok(d.runs.filter((r) => r.spec.step === "write-code").length >= 2, "implement ran again after the failure");

    const pr = d.outbox.find((m) => m.spec.action === "open-pull-request")!;
    assert.equal(pr.status?.result?.url, "https://github.com/ron96g/software-factory/pull/1");
    assert.deepEqual(s.published, [`${wi.metadata.name}-software-factory`]);
    assert.equal(s.prs[0].head, `factory/${wi.metadata.name}`);
    assert.equal(s.prs[0].base, "main");
    assert.equal(s.prs[0].draft, true);
    assert.match(s.prs[0].body, /Software Factory/);
    assert.equal(d.workItem.status?.stage, "ship");
  } finally {
    await f.stop();
  }
});

test("S5c: checks that keep failing exhaust maxAttempts and fail the item with the output", async () => {
  const s = setup([2]);
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Always red", description: "A long enough description for triage to accept it directly." });
    const d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.phase === "Failed");
    assert.match(d.workItem.status!.message!, /checks failed after 3 attempt\(s\)/);
    assert.match(d.workItem.status!.message!, /exit 2/);
    assert.equal(s.prs.length, 0, "no PR for a failed item");
  } finally {
    await f.stop();
  }
});

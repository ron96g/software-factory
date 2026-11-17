import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFactory, type Factory } from "./factory.ts";
import { InMemorySandboxEnvironment } from "./adapters/sandbox/basic.ts";
import { ANONYMOUS, type BaseConflictDetector, type PreparedWorkspace, type WorkspaceIntegrator } from "./ports/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const p = ANONYMOUS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(buildResults: number[], baseSync: BaseConflictDetector & WorkspaceIntegrator = movingBase(0), definitionsRoot = ROOT) {
  const commands: string[] = [];
  let builds = 0;
  const sandbox = new InMemorySandboxEnvironment({
    handlers: [
      (cmd) => {
        commands.push(cmd);
        if (cmd.includes("tsc")) return { exitCode: buildResults[Math.min(builds++, buildResults.length - 1)], stdout: "tsc output", stderr: "" };
        if (cmd.includes("npm test")) return { exitCode: 0, stdout: "29 passing" };
        if (cmd.includes("npm audit")) return { exitCode: 0, stdout: "found 0 vulnerabilities" };
        if (cmd.includes("npm run test:")) return { exitCode: 0, stdout: "2 passing" };
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
        definitionsRoot,
        databasePath: ":memory:",
        env: { FACTORY_SANDBOX_RUNTIME: "in-memory" },
        sandboxes: [sandbox],
        workspaceBackend: backend,
        checkPollMs: 20,
        baseSync,
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
    const wi = await f.app.createWorkItem(p, { title: "Checks and PR", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.outbox.some((m) => m.status?.phase === "Delivered"));
    assert.equal(d.workItem.status?.retries?.verify, 1, "one failed attempt consumed the retry budget");
    assert.ok(d.events.some((e) => e.spec.reason === "CheckFailed" && /build/.test(e.spec.message)));
    assert.ok(d.events.some((e) => e.spec.reason === "CheckPassed" && /unit-tests/.test(e.spec.message)));
    for (const check of ["integration-tests", "acceptance-criteria", "security-scan"]) {
      assert.ok(d.events.some((e) => e.spec.reason === "CheckPassed" && e.spec.message.startsWith(check)), `${check} really runs`);
    }
    assert.ok(!d.events.some((e) => e.spec.reason === "CheckNotImplemented"), "no required check passes without a command");
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

test("a repository without a git remote is not published: ship is reached with no pull request in the outbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-nogit-"));
  for (const entry of readdirSync(ROOT)) if (entry !== "repositories" && entry !== ".git") symlinkSync(join(ROOT, entry), join(root, entry));
  mkdirSync(join(root, "repositories"));
  const repos = readFileSync(join(ROOT, "repositories/repositories.yaml"), "utf8").replace(/\n  git: +# ADR-0023[^\n]*\n(    [^\n]*\n)+/, "\n");
  assert.ok(!/ron96g\/software-factory\.git/.test(repos), "the git section was removed");
  writeFileSync(join(root, "repositories/repositories.yaml"), repos);
  const s = setup([0], movingBase(0), root);
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "No remote", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.stage === "ship" && x.workItem.status.phase === "AwaitingApproval");
    assert.deepEqual(d.outbox.filter((m) => m.spec.action === "open-pull-request"), []);
    assert.deepEqual(s.published, []);
    assert.deepEqual(d.repositories.find((r) => r.name === "software-factory"), { name: "software-factory", publishable: false });
  } finally {
    await f.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("S5c: checks that keep failing exhaust maxAttempts and fail the item with the output", async () => {
  const s = setup([2]);
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Always red", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.phase === "Failed");
    assert.match(d.workItem.status!.message!, /checks failed after 3 attempt\(s\)/);
    assert.match(d.workItem.status!.message!, /exit 2/);
    assert.equal(s.prs.length, 0, "no PR for a failed item");
  } finally {
    await f.stop();
  }
});

/** ADR-0053 fake: the base moved and conflicts until `conflictingDetections` are used up. */
function movingBase(conflictingDetections: number) {
  const integrated: string[] = [];
  let detections = 0;
  return {
    integrated,
    detect: async () => (detections++ < conflictingDetections
      ? { baseCommit: `main${detections}`.padEnd(40, "0"), conflicts: ["web/src/app/page.tsx"] }
      : { baseCommit: "main-final".padEnd(40, "0"), conflicts: [] }),
    integrate: async (_ws: unknown, _repo: unknown, commit: string) => (integrated.push(commit), { baseCommit: commit, headCommit: "merged", conflicts: ["web/src/app/page.tsx"] }),
  };
}

test("ADR-0053: a publisher without base-conflict detection is rejected, whatever the runtime", async () => {
  await assert.rejects(
    createFactory({
      definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_SANDBOX_RUNTIME: "in-memory" }, log: () => {},
      publisher: { publish: async (ws) => ({ branch: ws.spec.branch, commit: "head456", pushed: true }) },
    }),
    /base-conflict detection/,
  );
});

test("ADR-0053: a PR that conflicts with the moved base is not opened; the base is merged and the developer resolves first", async () => {
  const base = movingBase(1);
  const s = setup([0], base);
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Parallel work", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.outbox.some((m) => m.status?.result?.url));
    const prs = d.outbox.filter((m) => m.spec.action === "open-pull-request");
    assert.equal(prs[0].status?.result?.conflict, true, "the first attempt reported the conflict instead of publishing");
    assert.equal(s.prs.length, 1, "only the resolved candidate was opened as a PR");
    assert.deepEqual(base.integrated, ["main1".padEnd(40, "0")]);
    assert.equal(d.workspaces[0].spec.integrate?.ref, "main");
    assert.equal(d.workspaces[0].status?.baseCommit, "main1".padEnd(40, "0"), "the workspace is re-pinned to the merged base");
    assert.equal(d.workItem.status?.retries?.["base-conflict"], 1);
    assert.ok(d.events.some((e) => e.spec.reason === "BaseConflict" && /page\.tsx/.test(e.spec.message)));
    const conflictRound = prs[0].metadata.name.match(/-ship-r(\d+)-pr-/)![1];
    assert.ok(!d.approvals.some((a) => a.metadata.name.endsWith(`-ship-r${conflictRound}`)), "the conflicting candidate never reached the ship gate");
    const codeRuns = d.runs.filter((r) => r.spec.step === "write-code");
    assert.ok(codeRuns.length >= 2, "implement ran again to resolve the conflict");
  } finally {
    await f.stop();
  }
});

test("ADR-0053: conflicts that keep coming back exhaust the budget and ask a human, never publishing", async () => {
  const s = setup([0], movingBase(99));
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Busy main", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    const d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.phase === "Blocked" && x.workItem.status.stage === "ship");
    assert.equal(d.workItem.status?.retries?.["base-conflict"], 2);
    const c = d.clarifications.find((x) => x.metadata.name === d.workItem.status?.blockedBy?.name)!;
    assert.deepEqual(c.spec.askedBy, { gate: "base-conflict" });
    assert.match(c.spec.details ?? "", /page\.tsx/);
    assert.equal(s.prs.length, 0);
    assert.equal(s.published.length, 0, "nothing was pushed");
  } finally {
    await f.stop();
  }
});

test("ADR-0054: updating a published PR whose base moved on merges the base, resolves and re-publishes to the same branch", async () => {
  const base = movingBase(0);
  let conflicting = 0;
  const detect = base.detect;
  base.detect = async () => (conflicting-- > 0 ? { baseCommit: "main2".padEnd(40, "0"), conflicts: ["web/src/app/page.tsx"] } : detect());
  const s = setup([0], base);
  const f = await s.make();
  await f.start();
  try {
    const wi = await f.app.createWorkItem(p, { title: "Published then stale", description: "A long enough description for triage to accept it directly.", workflowRef: "factory-loop" });
    await assert.rejects(f.app.updatePullRequest(p, wi.metadata.name), /has not reached ship/);
    let d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.stage === "ship");
    await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "approve");
    d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.phase === "Done");

    conflicting = 2; // other work landed on main after publication
    const [status] = await f.app.publishedPullRequests(p, wi.metadata.name);
    assert.deepEqual([status.number, status.base, status.conflicts], [1, "main", ["web/src/app/page.tsx"]]);

    await f.app.updatePullRequest(p, wi.metadata.name);
    d = await drive(f, wi.metadata.name, (x) => x.workItem.status?.stage === "ship" &&
      x.outbox.filter((m) => m.spec.action === "open-pull-request" && m.status?.result?.url).length === 2);
    assert.deepEqual(base.integrated, ["main2".padEnd(40, "0")], "the moved base was merged into the workspace");
    assert.ok(d.events.some((e) => e.spec.reason === "BaseConflict"));
    assert.equal(s.prs.length, 2);
    assert.equal(s.prs[1].head, s.prs[0].head, "the existing pull request branch is updated");
    assert.ok(d.runs.filter((r) => r.spec.step === "write-code" && !r.metadata.labels?.["factory.ai-dlc.io/superseded"]).length >= 2,
      "the developer resolved the conflict without restarting planning");
  } finally {
    await f.stop();
  }
});

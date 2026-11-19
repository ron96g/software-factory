import assert from "node:assert/strict";
import { test } from "node:test";
import { createIssueProposalController } from "./issues/controller.ts";

function setup(opts: { statuses: any[]; fail?: boolean }) {
  const store = new Map<string, any>();
  const put = (o: any) => store.set(`${o.kind}/${o.metadata.name}`, o);
  put({ kind: "Source", metadata: { name: "jira-main", namespace: "default" }, spec: { type: "jira", sync: { pollInterval: "5m" } } });
  put({ kind: "IssueProposal", metadata: { name: "p", namespace: "default", uid: "u1" }, spec: { purpose: "follow-up", title: "t", body: "b", targetRef: { name: "jira-main" } },
    status: { phase: "Created", externalRef: { externalId: "P-9" }, conditions: [{ type: "Linked", status: "False", reason: "NotRequested" }] } });
  let now = Date.parse("2026-01-01T00:00:00Z");
  let reads = 0;
  let writes = 0;
  const connector = { type: "jira", readIssueStatus: async () => { reads++; if (opts.fail) throw new Error("down"); return opts.statuses.shift(); } };
  const reader: any = { get: async (k: string, _n: string, name: string) => store.get(`${k}/${name}`) ?? null, list: async (k: string) => [...store.values()].filter((o) => o.kind === k) };
  const c = createIssueProposalController({
    reader, clock: { now: () => new Date(now) }, status: { updateStatus: async (o: any) => { writes++; put(o); return o; } } as any,
    events: { normal: async () => {}, warning: async () => {} }, outbox: { enqueue: async () => {} } as any,
    connectors: { get: () => connector as any, keys: () => ["jira"] },
  });
  return { c, advance: (ms: number) => { now += ms; }, reads: () => reads, writes: () => writes, p: () => store.get("IssueProposal/p") };
}

test("AC-4: tracking reads at most once per pollInterval, writes status.tracked, stops when closed", async () => {
  const t = setup({ statuses: [{ state: "Open", open: true, assignee: "ann" }, { state: "Done", open: false }] });
  assert.deepEqual(await t.c.reconcile("default/p"), { requeueAfterMs: 300_000 });
  assert.equal(t.p().status.tracked.assignee, "ann");
  assert.equal(t.p().status.tracked.readAt, "2026-01-01T00:00:00.000Z");
  t.advance(60_000);
  assert.deepEqual(await t.c.reconcile("default/p"), { requeueAfterMs: 240_000 });
  assert.equal(t.reads(), 1);
  t.advance(240_000);
  assert.equal(await t.c.reconcile("default/p"), undefined);
  assert.equal(t.p().status.tracked.open, false);
  await t.c.reconcile("default/p");
  assert.equal(t.reads(), 2);
});

test("AC-4: a failing read keeps the ticket Created and retries after the interval", async () => {
  const t = setup({ statuses: [], fail: true });
  assert.deepEqual(await t.c.reconcile("default/p"), { requeueAfterMs: 300_000 });
  assert.equal(t.p().status.phase, "Created");
  assert.equal(t.writes(), 0);
});

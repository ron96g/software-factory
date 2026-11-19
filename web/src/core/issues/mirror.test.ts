import assert from "node:assert/strict";
import { test } from "node:test";
import { createIssueProposalController } from "./controller.ts";
import { mirrorLinkChecker, LABEL_EXTERNAL_REF } from "./mirror.ts";
import { DefaultSourceSyncer } from "../sources/syncer.ts";

function world(item: any) {
  const store = new Map<string, any>();
  const put = (o: any) => store.set(`${o.kind}/${o.metadata.name}`, o);
  put({ kind: "WorkItem", metadata: { name: "w", namespace: "default" }, spec: { title: "t", sourceRef: { name: "manual" }, ...item } });
  put({ kind: "IssueProposal", metadata: { name: "w-mirror", namespace: "default", uid: "u9" }, spec: { purpose: "mirror", title: "t", body: "b", targetRef: { name: "gh" }, provenance: { workItem: "w" } }, status: { phase: "Created", externalRef: { externalId: "7", url: "u" } } });
  const reader: any = {
    get: async (k: string, _n: string, n: string) => store.get(`${k}/${n}`) ?? null,
    list: async (k: string, o?: any) => [...store.values()].filter((x) => x.kind === k && Object.entries(o?.labelSelector ?? {}).every(([a, b]) => x.metadata.labels?.[a] === b)),
  };
  const events: string[] = [];
  const c = createIssueProposalController({
    reader, clock: { now: () => new Date() }, status: { updateStatus: async (o: any) => { put(o); return o; } } as any,
    events: { normal: async (_o: any, r: string) => { events.push(r); }, warning: async (_o: any, r: string) => { events.push(r); } },
    outbox: {} as any, connectors: { get: () => undefined, keys: () => [] }, workItems: { update: async (o: any) => { put(o); return o; } } as any,
  } as any);
  return { c, store, reader, events };
}

test("mirror: Created proposal links sourceRef, externalRef and label, then Linked=True", async () => {
  const w = world({});
  await w.c.reconcile("default/w-mirror");
  const item = w.store.get("WorkItem/w");
  assert.deepEqual(item.spec.sourceRef, { name: "gh" });
  assert.equal(item.spec.externalRef.id, "7");
  assert.equal(item.metadata.labels[LABEL_EXTERNAL_REF], "gh.7");
  assert.equal(w.store.get("IssueProposal/w-mirror").status.conditions[0].status, "True");
  assert.deepEqual(w.events, ["MirrorLinked"]);
});

test("mirror: a different existing externalRef is a Conflict and is not overwritten", async () => {
  const w = world({ externalRef: { id: "99" } });
  await w.c.reconcile("default/w-mirror");
  assert.equal(w.store.get("WorkItem/w").spec.externalRef.id, "99");
  assert.equal(w.store.get("IssueProposal/w-mirror").status.conditions[0].reason, "Conflict");
  assert.deepEqual(w.events, ["MirrorConflict"]);
});

test("syncer skips an unlinked mirror marker, then finds the linked item by label without a duplicate", async () => {
  const w = world({});
  const created: any[] = [];
  const updates: any[] = [];
  const connector: any = { type: "github", fetchItems: async () => [{ externalId: "7", title: "t", description: "x\n\n[software-factory:issue-u9]", url: "u", updatedAt: "1" }] };
  const syncer = new DefaultSourceSyncer({
    reader: w.reader, writer: { create: async (o: any) => { created.push(o); return o; }, update: async (o: any) => { updates.push(o); return o; }, delete: async () => {} },
    connectors: { get: () => connector, keys: () => ["github"] }, events: { normal: async () => {}, warning: async () => {} },
    mirrors: mirrorLinkChecker({ reader: w.reader }),
  } as any);
  w.store.set("Source/gh", { kind: "Source", metadata: { name: "gh", namespace: "default" }, spec: { type: "github" } });
  assert.deepEqual(await syncer.sync("gh"), { created: 0, updated: 0 });
  await w.c.reconcile("default/w-mirror");
  assert.deepEqual(await syncer.sync("gh"), { created: 0, updated: 1 });
  assert.equal(created.length, 0);
  assert.equal(updates[0].metadata.name, "w");
});

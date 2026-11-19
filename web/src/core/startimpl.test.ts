import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory } from "./factory.ts";
import { ANONYMOUS as p } from "./ports/index.ts";
import { DefaultSourceSyncer } from "./sources/syncer.ts";
import { followUpOriginResolver } from "./issues/origin.ts";
import { DefaultWorkItemRecordReader } from "./agents/work-item-record.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

async function setup() {
  const f = await createFactory({ definitionsRoot: ROOT, databasePath: ":memory:", env: { FACTORY_SIMULATION: "wait" }, fetch: async () => new Response("no", { status: 503 }) });
  const item = await f.app.createWorkItem(p, { title: "Spec key order", description: "Keys are reordered." });
  const name = item.metadata.name;
  const preview = await f.app.previewWorkItemFollowUp(p, name, "");
  const prop = await f.app.createFollowUpTicket(p, name, { requestId: "r1", expectedRevision: preview.revision, title: "Keep order", targetSource: "jira-main" });
  return { f, name, prop };
}

async function markCreated(f: any, propName: string) {
  const cur: any = await (f.app as any).d.reader.get("IssueProposal", "default", propName);
  return (f.app as any).d.writer.updateStatus({ ...cur, status: { phase: "Created", externalRef: { externalId: "DHEI-7", url: "https://j/browse/DHEI-7" } } });
}

test("AC-5: Start implementation is explicit, idempotent and carries origin + snapshot; sync converges to the same item", async () => {
  const { f, name, prop } = await setup();
  try {
    await assert.rejects(f.app.startImplementation(p, prop.metadata.name), /not created/);
    const created: any = await markCreated(f, prop.metadata.name);
    const wi = await f.app.startImplementation(p, prop.metadata.name);
    assert.equal(wi.metadata.name, "jira-main-dhei-7");
    assert.equal(wi.spec.originWorkItemRef?.name, name);
    assert.ok(wi.spec.originSnapshot?.content.includes("Keys are reordered"));
    assert.equal(wi.spec.externalRef?.id, "DHEI-7");
    const again = await f.app.startImplementation(p, prop.metadata.name);
    assert.equal(again.metadata.uid, wi.metadata.uid);

    const connector: any = { type: "jira", fetchItems: async () => [{ externalId: "DHEI-7", title: "Keep order", description: `x\n\n[software-factory:issue-${created.metadata.uid}]`, url: "u", updatedAt: "1" }] };
    const syncer = new DefaultSourceSyncer({ reader: (f.app as any).d.reader, writer: (f.app as any).d.writer, connectors: { get: () => connector, keys: () => ["jira"] }, events: { normal: async () => {}, warning: async () => {} },
      origins: followUpOriginResolver({ reader: (f.app as any).d.reader, records: (f.app as any).d.records, redactor: { redact: (s: string) => s } as any, clock: { now: () => new Date() } }) } as any);
    await syncer.sync("jira-main");
    const all = (await (f.app as any).d.reader.list("WorkItem", { namespace: "default" })).filter((w: any) => w.spec.externalRef);
    assert.equal(all.length, 1);
  } finally { await f.stop(); }
});

test("AC-5: sync first attaches origin and snapshot, then Start implementation returns that item", async () => {
  const { f, name, prop } = await setup();
  try {
    const created: any = await markCreated(f, prop.metadata.name);
    const connector: any = { type: "jira", fetchItems: async () => [{ externalId: "DHEI-7", title: "Keep order", description: `x\n\n[software-factory:issue-${created.metadata.uid}]`, url: "u", updatedAt: "1" }] };
    const syncer = new DefaultSourceSyncer({ reader: (f.app as any).d.reader, writer: (f.app as any).d.writer, connectors: { get: () => connector, keys: () => ["jira"] }, events: { normal: async () => {}, warning: async () => {} },
      origins: followUpOriginResolver({ reader: (f.app as any).d.reader, records: (f.app as any).d.records, redactor: { redact: (s: string) => s } as any, clock: { now: () => new Date() } }) } as any);
    await syncer.sync("jira-main");
    const wi = await f.app.startImplementation(p, prop.metadata.name);
    assert.equal(wi.spec.originWorkItemRef?.name, name);
    assert.ok(wi.spec.originSnapshot);
    assert.equal((await (f.app as any).d.reader.list("WorkItem", { namespace: "default" })).filter((w: any) => w.spec.externalRef).length, 1);
  } finally { await f.stop(); }
});

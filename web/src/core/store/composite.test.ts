import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { resolve } from "node:path";
import { SqliteStore } from "./sqlite-store.ts";
import { GitDefinitionLoader } from "./definition-loader.ts";
import { CompositeStore, DefinitionStore, ScopeRouter } from "./composite-store.ts";
import { AdmissionChain, AdmittedStore } from "../admission/chain.ts";
import { nameValidator, namespaceDefaulter, refValidator, sourceDefaultsMutator } from "../admission/builtins.ts";
import { KindRegistry } from "../registry/registry.ts";
import { BUILTIN_KINDS } from "../registry/kinds.ts";
import { isStoreError } from "../ports/index.ts";
import type { WorkItem } from "../model/kinds.ts";
import { SqliteTranscriptStore } from "../transcripts/sqlite-transcripts.ts";
import { DefaultRecorderFactory, SecretRedactor } from "../transcripts/recorder.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const clock = { now: () => new Date() };

async function setup() {
  const kinds = new KindRegistry();
  BUILTIN_KINDS.forEach((k) => kinds.register(k));
  const runtime = new SqliteStore(new DatabaseSync(":memory:"), clock);
  const defs = await new DefinitionStore(new GitDefinitionLoader(ROOT)).init();
  const composite = new CompositeStore(new ScopeRouter(kinds, defs, runtime), [defs, runtime]);
  const chain = new AdmissionChain();
  chain.addMutator(namespaceDefaulter(kinds));
  chain.addMutator(sourceDefaultsMutator());
  chain.addValidator(nameValidator());
  chain.addValidator(refValidator());
  return { store: new AdmittedStore(composite, chain), defs };
}

const wi = (name: string, source = "manual"): WorkItem => ({
  apiVersion: "factory.ai-dlc.io/v1alpha1",
  kind: "WorkItem",
  metadata: { name },
  spec: { title: "t", sourceRef: { name: source } },
});

test("definitions load from the repo into factory-system", async () => {
  const { store } = await setup();
  const agent = await store.get("Agent", "factory-system", "triager");
  assert.ok(agent && "body" in agent && (agent as { body: string }).body.includes("Triager"));
  assert.ok((await store.list("ArtifactType")).length > 5);
  await assert.rejects(store.create({ ...agent!, metadata: { name: "x" } }), (e) => isStoreError(e, "ReadOnly"));
});

test("admission: namespace + source defaults + labels", async () => {
  const { store } = await setup();
  const created = await store.create(wi("a", "jira-main"));
  assert.equal(created.metadata.namespace, "default");
  assert.equal(created.spec.workflowRef?.name, "factory-loop");
  assert.deepEqual(created.spec.repositoryRefs?.map((r) => r.name), ["shop-backend", "shop-frontend"]);
  assert.equal(created.metadata.labels?.["factory.ai-dlc.io/source"], "jira-main");
});

test("admission: unresolved refs and bad names are rejected", async () => {
  const { store } = await setup();
  await assert.rejects(store.create(wi("b", "nope")), (e) => isStoreError(e, "Invalid") && /Source "nope"/.test(e.message));
  await assert.rejects(store.create(wi("Bad_Name")), (e) => isStoreError(e, "Invalid"));
});

test("transcripts: append-only, ordered, redacted", async () => {
  const db = new DatabaseSync(":memory:");
  const ts = new SqliteTranscriptStore(db, clock);
  const redactor = new SecretRedactor();
  redactor.add("sk-supersecret");
  const rec = await new DefaultRecorderFactory(ts, redactor).forRun({
    apiVersion: "x",
    kind: "AgentRun",
    metadata: { name: "r", namespace: "default" },
    spec: {} as never,
  });
  const tailed: number[] = [];
  ts.tail(rec.ref, (m) => tailed.push(m.seq));
  await rec.record({ role: "system", author: { type: "system", id: "t" }, content: "hello" });
  await rec.record({ role: "assistant", author: { type: "agent", id: "a" }, content: "key sk-supersecret" });
  await rec.record({ role: "tool-result", author: { type: "system", id: "t" }, content: "ok", meta: { tool: "x", arg: "Bearer sk-supersecret" } });
  const msgs = await ts.read(rec.ref);
  assert.deepEqual(msgs.map((m) => m.seq), [1, 2, 3]);
  assert.equal(msgs[1].content, "key «redacted»");
  assert.equal(msgs[2].meta?.arg, "Bearer «redacted»");
  assert.deepEqual(tailed, [1, 2, 3]);
  assert.equal((await ts.read(rec.ref, { afterSeq: 1 })).length, 2);
});

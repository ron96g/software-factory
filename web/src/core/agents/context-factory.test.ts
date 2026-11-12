import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultContextFactory } from "./context-factory.ts";

const owner = [{ apiVersion: "x", kind: "WorkItem", name: "wi" }];
const run = (name: string, labels?: Record<string, string>) => ({
  kind: "AgentRun",
  metadata: { name, namespace: "default", ownerReferences: owner, labels },
  spec: { workItemRef: { name: "wi" }, agentRef: { name: "a" }, skillRefs: [], stage: "spec", step: "s", inputs: [{ name: "spec" }], outputs: [] },
});
const artifact = (name: string, producer: string, labels?: Record<string, string>) => ({
  kind: "Artifact",
  metadata: { name, namespace: "default", ownerReferences: owner, labels },
  spec: { artifactTypeRef: { name: "spec" }, producedBy: { agentRunRef: { name: producer } }, content: name },
});

function setup(objects: { kind: string; metadata: { name: string } }[]) {
  let opened = 0;
  let provided = 0;
  const reader = {
    get: async (kind: string, _ns: string, name: string) =>
      kind === "Agent" ? { kind, metadata: { name }, spec: {} } : kind === "WorkItem" ? { kind, metadata: { name, namespace: "default" }, spec: {} } : null,
    list: async (kind: string) => objects.filter((o) => o.kind === kind),
  };
  const factory = new DefaultContextFactory({
    reader: reader as never,
    providers: [{ appliesTo: () => true, provide: async () => (provided++, []) }] as never,
    models: { resolve: async () => undefined } as never,
    recorders: { forRun: async () => (opened++, { ref: { namespace: "default", id: "t" }, record: async () => {} }) } as never,
    environments: {} as never,
  });
  return { factory, counts: () => ({ opened, provided }) };
}

test("preview is side-effect free: no transcript opened, no context providers, recording throws", async () => {
  const { factory, counts } = setup([]);
  const ctx = await factory.preview(run("r1") as never);
  assert.deepEqual(counts(), { opened: 0, provided: 0 });
  await assert.rejects(ctx.transcript.record({ role: "note", author: { type: "system", id: "x" }, content: "x" }), /preview/);
  await factory.create(run("r1") as never);
  assert.deepEqual(counts(), { opened: 1, provided: 1 });
});

test("output of a superseded run is never input, even when it landed after the restart labelled artifacts", async () => {
  const { factory } = setup([
    artifact("spec-current", "r-new"),
    run("r-old", { "factory.ai-dlc.io/superseded": "x" }),
    artifact("spec-late-from-old-run", "r-old"), // created after the restart, so it has no label itself
  ]);
  const ctx = await factory.create(run("r-next") as never);
  assert.deepEqual(ctx.inputs.map((a) => a.metadata.name), ["spec-current"]);
});

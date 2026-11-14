import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusWriter, type StatusPort } from "./status.ts";
import { K8sLoader, type RestPort } from "./loader.ts";
import type { Resource } from "../model/resource.ts";

const res = (name: string): Resource =>
  ({ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "Skill", metadata: { name, namespace: "a" }, spec: { x: 1 } }) as unknown as Resource;
const mk = () => {
  const calls: any[] = [];
  const port: StatusPort = { putStatus: async (t, s) => void calls.push({ t, s }) };
  return { calls, w: new StatusWriter(port, () => "T") };
};

test("AC-8 writes only a Ready condition to status", async () => {
  const { calls, w } = mk();
  await w.accepted(res("s"));
  assert.deepEqual(Object.keys(calls[0].s), ["conditions"]);
  assert.deepEqual(Object.keys(calls[0].t).sort(), ["kind", "name", "namespace"]);
  assert.equal(calls[0].s.conditions[0].status, "True");
});
test("AC-8 Ready=False for rejection, referenced delete, missing secret", async () => {
  const { calls, w } = mk();
  await w.rejected(res("a"), "schema bad");
  await w.rejected(res("b"), "referenced by Agent a");
  await w.missingSecret(res("c"), "tok");
  assert.deepEqual(calls.map((c) => c.s.conditions[0].status), ["False", "False", "False"]);
  assert.equal(calls[2].s.conditions[0].reason, "SecretMissing");
});
test("identical status is not rewritten; failures do not throw", async () => {
  const { calls, w } = mk();
  await w.accepted(res("s"));
  await w.accepted(res("s"));
  assert.equal(calls.length, 1);
  const bad = new StatusWriter({ putStatus: async () => { throw new Error("x"); } });
  await bad.accepted(res("s"));
});
test("loader reports accepted and rejected through the writer", async () => {
  const { calls, w } = mk();
  const rest: RestPort = {
    list: async () => ({ items: [], resourceVersion: "1" }),
    async *watch(_rv, signal) {
      yield { type: "ADDED", object: res("ok") };
      yield { type: "ADDED", object: res("bad") };
      await new Promise((r) => signal.addEventListener("abort", r));
    },
  };
  const l = new K8sLoader(rest, { onReject: (r, why) => void w.rejected(r, why), onAccept: (r) => void w.accepted(r) });
  await l.load();
  l.start({ apply: async (d) => (d.metadata.name === "bad" ? { ok: false, reason: "nope" } : { ok: true }), remove: async () => ({ ok: true }) });
  await new Promise((r) => setTimeout(r, 50));
  await l.stop();
  assert.deepEqual(calls.map((c) => c.s.conditions[0].status).sort(), ["False", "True"]);
});

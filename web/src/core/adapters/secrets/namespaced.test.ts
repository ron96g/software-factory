import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { NamespacedSecretReader } from "../../ports/index.ts";
import { NamespacedSecretResolver } from "./namespaced.ts";
import { DEFINITION_CRDS, CRD_GROUP } from "../../store/cr-mapper.ts";

const reader: NamespacedSecretReader = { readSecrets: async (ns: string) => (ns === "factory-secrets" ? { "api-key": { value: "s3" }, other: { a: "x" } } : ({} as Record<string, Record<string, string>>)) };

test("resolves only after refresh, from the configured namespace", async () => {
  const r = new NamespacedSecretResolver(reader, "factory-secrets");
  assert.equal(r.resolve({ name: "api-key" }), undefined);
  await r.refresh();
  assert.equal(r.resolve({ name: "api-key" }), "s3");
  assert.equal(r.resolve({ name: "other" }), "x");
  assert.equal(r.resolve({ name: "missing" }), undefined);
  assert.equal(r.resolve(undefined), undefined);
});

test("refuses refs outside the secret namespace", async () => {
  const r = new NamespacedSecretResolver(reader, "factory-secrets");
  await r.refresh();
  assert.equal(r.resolve({ name: "api-key", namespace: "kube-system" } as never), undefined);
  assert.equal(r.resolve({ name: "api-key", namespace: "factory-secrets" } as never), "s3");
});

test("AC-9: a CRD exists per definition kind and RBAC has no cluster-wide secrets", () => {
  const dir = new URL("../../../../../deploy/kubernetes/", import.meta.url);
  const crds = readFileSync(new URL("crds.yaml", dir), "utf8");
  for (const [kind, c] of Object.entries(DEFINITION_CRDS)) {
    assert.ok(crds.includes(`name: ${c.plural}.${CRD_GROUP}`), kind);
    assert.ok(crds.includes(`kind: ${kind}\n`), kind);
  }
  assert.ok(existsSync(new URL("example-agent.yaml", dir)));
  const rbac = readFileSync(new URL("rbac.yaml", dir), "utf8");
  const [cluster, ns] = rbac.split("kind: Role\n");
  assert.ok(!cluster.includes("secrets"));
  assert.ok(ns.includes("secrets"));
});

test("AC-10: rotated Secrets are picked up by watch, watch close and periodic re-list; cache swapped atomically", async () => {
  let value = "v1";
  let reads = 0;
  const rotating: NamespacedSecretReader = { readSecrets: async () => { reads++; return { tok: { value } }; } };
  let onChange: (() => void) | undefined;
  let onClose: ((err?: Error) => void) | undefined;
  const watched: string[] = [];
  let unsubscribed = 0;
  const watcher = { watchSecrets: (ns: string, c: () => void, cl: (err?: Error) => void) => { watched.push(ns); onChange = c; onClose = cl; return () => { unsubscribed++; }; } };
  const logs: string[] = [];
  const r = new NamespacedSecretResolver(rotating, "factory-secrets");
  await r.refresh();
  r.start({ watcher, relistMs: 20, rewatchMs: 5, log: (m) => logs.push(m) });
  assert.deepEqual(watched, ["factory-secrets"]);
  value = "v2";
  onChange!();
  await new Promise((res) => setTimeout(res, 1));
  assert.equal(r.resolve({ name: "tok" }), "v2");
  value = "v3";
  onClose!(new Error("gone"));
  await new Promise((res) => setTimeout(res, 15));
  assert.equal(r.resolve({ name: "tok" }), "v3");
  assert.equal(watched.length, 2, "watch re-opened after close");
  value = "v4";
  const before = reads;
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(reads > before, "periodic re-list ran");
  assert.equal(r.resolve({ name: "tok" }), "v4");
  r.stop();
  assert.ok(unsubscribed >= 1);
  assert.ok(logs.every((l) => !/v[1-4]/.test(l)), "secret values never logged");
  const after = reads;
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(reads, after, "stopped: no more re-lists");
});

test("a failed refresh keeps the last cache", async () => {
  let fail = false;
  const r = new NamespacedSecretResolver({ readSecrets: async () => { if (fail) throw new Error("x"); return { tok: { value: "a" } }; } }, "ns");
  await r.refresh();
  fail = true;
  await assert.rejects(r.refresh());
  assert.equal(r.resolve({ name: "tok" }), "a");
});

test("AC-10: RBAC grants get/list/watch on secrets only via a namespaced Role, never a ClusterRole", () => {
  const rbac = readFileSync(new URL("../../../../../deploy/kubernetes/rbac.yaml", import.meta.url), "utf8");
  const docs = rbac.split(/^---$/m);
  for (const d of docs.filter((x) => /kind: ClusterRole\n/.test(x))) assert.ok(!d.includes("secrets"));
  const role = docs.find((x) => /kind: Role\n/.test(x) && x.includes("secrets"))!;
  assert.ok(role.includes("namespace: factory-secrets"));
  assert.ok(role.includes('verbs: ["get", "list", "watch"]'));
});

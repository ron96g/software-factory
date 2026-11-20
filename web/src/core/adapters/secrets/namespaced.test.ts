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

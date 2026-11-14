import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCrds, buildClusterRole, renderManifests, DEFINITION_KINDS } from "./crds.ts";

test("AC-9: 9 CRDs with status subresource and schema", () => {
  const crds = buildCrds();
  assert.equal(crds.length, 9);
  for (const c of crds) {
    const v = c.spec.versions[0];
    assert.deepEqual(v.subresources, { status: {} });
    assert.ok(v.schema.openAPIV3Schema.properties.spec);
    assert.equal(c.metadata.name, `${c.spec.names.plural}.factory.ai-dlc.io`);
  }
  assert.equal(new Set(crds.map((c) => c.spec.names.kind)).size, DEFINITION_KINDS.length);
});

test("AC-9: Agent/Skill map body to spec.body", () => {
  for (const c of buildCrds()) {
    const has = !!(c.spec.versions[0].schema.openAPIV3Schema.properties.spec as any).properties?.body;
    assert.equal(has, ["Agent", "Skill"].includes(c.spec.names.kind));
  }
});

test("AC-9: ClusterRole least privilege", () => {
  const r = buildClusterRole().rules;
  assert.deepEqual(r[0].verbs, ["list", "watch"]);
  assert.deepEqual(r[1].verbs, ["update"]);
  assert.ok(r[1].resources.every((x) => x.endsWith("/status")));
  assert.deepEqual(r[2], { apiGroups: [""], resources: ["secrets"], verbs: ["get"] });
  assert.ok(!JSON.stringify(r).includes("*"));
});

test("AC-9: committed deploy/crds.yaml is up to date", () => {
  assert.equal(readFileSync(new URL("../../../../deploy/crds.yaml", import.meta.url), "utf8"), renderManifests());
});

test("AC-9: CRD schema derived from schemas/ (spec required, object)", () => {
  for (const c of buildCrds()) {
    const sch = c.spec.versions[0].schema.openAPIV3Schema as any;
    assert.deepEqual(sch.required, ["spec"]);
    assert.equal(sch.properties.spec.type, "object");
    assert.ok(!("$schema" in sch.properties.spec));
  }
});

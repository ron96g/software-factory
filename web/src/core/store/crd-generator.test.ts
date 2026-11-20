import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { generateCrds } from "./crd-generator.ts";
import { DEFINITION_CRDS } from "./cr-mapper.ts";

test("deploy/kubernetes/crds.yaml is in sync with the generator (run `npm run gen:crds`)", () => {
  const file = readFileSync(new URL("../../../../deploy/kubernetes/crds.yaml", import.meta.url), "utf8");
  assert.equal(file, generateCrds());
});

test("one CRD per definition kind; Agent/Skill require spec.body", () => {
  const docs = parseAllDocuments(generateCrds()).map((d) => d.toJS());
  assert.equal(docs.length, Object.keys(DEFINITION_CRDS).length);
  const agent = docs.find((d) => d.spec.names.kind === "Agent");
  assert.deepEqual(agent.spec.versions[0].schema.openAPIV3Schema.properties.spec.required, ["role", "body"]);
  const rules = docs.flatMap((d) => JSON.stringify(d).match(/x-kubernetes-validations/g) ?? []);
  assert.ok(rules.length >= 8, "CRDs carry CEL rules");
  assert.ok(!docs.some((d) => d.spec.versions[0].schema.openAPIV3Schema.properties.spec["x-kubernetes-preserve-unknown-fields"]), "spec is strictly typed");
});

test("ref namespaces are free-form DNS labels, not pinned to factory-system", () => {
  const out = generateCrds();
  assert.ok(!out.includes("factory-system"));
  const docs = parseAllDocuments(out).map((d) => d.toJS());
  const wf = docs.find((d) => d.spec.names.kind === "Workflow");
  const refSchema = JSON.stringify(wf).match(/"pattern":"\^\[a-z0-9\]\(\[-a-z0-9\]\*\[a-z0-9\]\)\?\$"/);
  assert.ok(refSchema, "namespace uses a DNS-1123 pattern");
  assert.ok(new RegExp("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$").test("team-a"));
});

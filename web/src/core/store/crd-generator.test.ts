import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { generateCrds } from "./crd-generator.ts";
import { DEFINITION_CRDS } from "./cr-mapper.ts";

test("deploy/kubernetes/crds.yaml is in sync with the generator (run `npm run crds:generate`)", () => {
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

function freeFormPaths(schema: Record<string, any>, path: string, out: string[] = []): string[] {
  if (schema["x-kubernetes-preserve-unknown-fields"]) out.push(path);
  for (const [k, v] of Object.entries(schema.properties ?? {})) freeFormPaths(v as Record<string, any>, `${path}.${k}`, out);
  if (schema.items) freeFormPaths(schema.items, `${path}[]`, out);
  if (typeof schema.additionalProperties === "object") freeFormPaths(schema.additionalProperties, `${path}{}`, out);
  return out;
}

test("AC-4: only deliberately tagged fields are free-form (new ones need @preserveUnknownFields and an entry here)", () => {
  const docs = parseAllDocuments(generateCrds()).map((d) => d.toJS());
  const paths = docs.flatMap((d) => freeFormPaths(d.spec.versions[0].schema.openAPIV3Schema.properties.spec, d.spec.names.kind)).sort();
  assert.deepEqual(paths, [
    "Agent.invocation",
    "ArtifactType.schema.jsonSchema",
    "Repository.checks{}",
    "Repository.observability",
    "Source.connection",
    "Source.sync.filter",
    "Source.writeBack.issues.fields",
    "Workflow.humanInput",
    "Workflow.loop",
    "Workflow.phases[].stages[].gate.onFailure",
  ]);
});

test("AC-4: generation is deterministic and every Spec field appears in the CRD", () => {
  assert.equal(generateCrds(), generateCrds());
  const docs = parseAllDocuments(generateCrds()).map((d) => d.toJS());
  const repo = docs.find((d) => d.spec.names.kind === "Repository").spec.versions[0].schema.openAPIV3Schema.properties.spec;
  assert.ok(repo.properties.index.properties.refreshOn, "fields come from model/kinds.ts");
  assert.ok(repo["x-kubernetes-validations"].some((v: { rule: string }) => v.rule.includes("has(self.git)")), "CEL from JSDoc tags");
});

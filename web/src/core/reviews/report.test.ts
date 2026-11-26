import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { AjvSchemaValidator } from "../adapters/schema/ajv.ts";
import { permittedEvent } from "./pr-review.ts";
import type { Source } from "../model/kinds.ts";

const schema = parse(readFileSync(resolve(import.meta.dirname, "../../../../artifacts/pr-review-report.yaml"), "utf8")).spec.schema.jsonSchema;
const v = new AjvSchemaValidator();
const blocking = { severity: "blocking", path: "a.ts", line: 3, message: "Breaks callers." };
const base = { summary: "Renames the config loader entry point.", rationale: "Explains the verdict in enough words." };

test("the pr-review-report verdict must agree with its findings and required changes", () => {
  assert.equal(v.validate(schema, { ...base, verdict: "accepted", accepted: [], requiredChanges: [], findings: [] }), undefined);
  assert.ok(v.validate(schema, { ...base, verdict: "accepted", accepted: [], requiredChanges: [], findings: [blocking] }), "accepted with a blocking finding");
  assert.ok(v.validate(schema, { ...base, verdict: "accepted", accepted: [], requiredChanges: ["Fix it now"], findings: [] }), "accepted with required changes");
  assert.ok(v.validate(schema, { ...base, verdict: "partially-accepted", accepted: [], requiredChanges: ["Fix it now"], findings: [] }), "partial without accepted parts");
  assert.ok(v.validate(schema, { ...base, verdict: "partially-accepted", accepted: ["The rename"], requiredChanges: [], findings: [] }), "partial without required changes");
  assert.equal(v.validate(schema, { ...base, verdict: "partially-accepted", accepted: ["The rename"], requiredChanges: ["Keep the old name as an alias"], findings: [blocking] }), undefined);
  assert.ok(v.validate(schema, { ...base, verdict: "rejected", accepted: [], requiredChanges: [], findings: [blocking] }), "rejected without what must change");
  assert.ok(v.validate(schema, { ...base, verdict: "approve", accepted: [], requiredChanges: [], findings: [] }), "old verdict values are refused");
});

test("the GitHub event follows the verdict where permitted, else falls back to a comment", () => {
  const source = (events: string[]) => ({ spec: { type: "github-pr", writeBack: { pullRequestReviews: events } } }) as unknown as Source;
  const all = source(["approve", "comment", "request-changes"]);
  assert.equal(permittedEvent(all, "accepted"), "approve");
  assert.equal(permittedEvent(all, "partially-accepted"), "request-changes");
  assert.equal(permittedEvent(all, "rejected"), "request-changes");
  assert.equal(permittedEvent(source(["comment"]), "accepted"), "comment");
  assert.equal(permittedEvent(source([]), "rejected"), undefined);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePlanningRevision } from "./planning-request.ts";

const request = { revision: "revision-1", requestId: "request-1", action: "revise" };
const draft = { outcome: "Outcome", scope: "Scope", approach: "Approach", delivery: "Delivery", acceptance: "Acceptance", risks: "Risks" };

test("planning requests preserve intent and accept all explicit actions", () => {
  for (const action of ["revise", "decisions", "reopen", "reject", "defer"]) {
    const input = { ...request, action, draft, context: "", feedback: "  Keep formatting  ", answers: { choice: "Custom answer" } };
    assert.deepEqual(parsePlanningRevision(input), input);
  }
});

test("planning requests accept only explicit one-planner workflow migrations", () => {
  const input = { ...request, action: "migrate", workflow: "factory-plan" };
  assert.deepEqual(parsePlanningRevision(input), input);
  for (const invalid of [
    { ...request, action: "migrate" },
    { ...request, action: "migrate", workflow: "not a workflow" },
    { ...input, context: "also change context" },
    { ...request, action: "revise", workflow: "factory-plan" },
  ]) assert.throws(() => parsePlanningRevision(invalid));
});

test("planning requests accept a risks-only decision-sheet draft but not a partial six-section draft", () => {
  const input = { ...request, draft: { risks: "Risks" } };
  assert.deepEqual(parsePlanningRevision(input), input);
  assert.throws(() => parsePlanningRevision({ ...request, draft: { risks: "Risks", outcome: "Outcome" } }), /all six text sections or only risks/);
});

test("planning requests accept a decision-answer withdrawal", () => {
  const input = { ...request, action: "decisions", withdraw: ["stale-answer"] };
  assert.deepEqual(parsePlanningRevision(input), input);
});

test("planning requests reject unknown fields, wrong types and incomplete sections", () => {
  for (const input of [
    null, [], "revise", { ...request, action: "approve" }, { ...request, revision: " " },
    { ...request, requestId: 3 }, { ...request, requestId: "x".repeat(101) }, { ...request, requestId: "bad id" },
    { ...request, override: true }, { ...request, context: null }, { ...request, feedback: [] },
    { ...request, draft: {} }, { ...request, draft: { ...draft, outcome: 1 } }, { ...request, draft: { ...draft, outcome: "" } },
    { ...request, draft: { ...draft, units: [] } }, { ...request, answers: [] },
    { ...request, answers: { choice: true } }, { ...request, answers: { "": "answer" } }, { ...request, answers: { choice: " " } },
    { ...request, context: "x".repeat(20_001) }, { ...request, feedback: "x".repeat(20_001) },
    { ...request, draft: { ...draft, risks: "x".repeat(12_001) } }, { ...request, answers: { choice: "x".repeat(4001) } },
    { ...request, action: "decisions", withdraw: "choice" },
    { ...request, action: "decisions", withdraw: ["choice", "choice"] },
    { ...request, action: "decisions", withdraw: ["invalid id"] },
  ]) assert.throws(() => parsePlanningRevision(input));
});

test("answer IDs cannot mutate the parsed record prototype", () => {
  const input = JSON.parse('{"revision":"r","requestId":"id","action":"decisions","answers":{"__proto__":"custom"}}');
  const parsed = parsePlanningRevision(input);
  assert.equal(parsed.answers?.["__proto__"], "custom");
  assert.equal(Object.getPrototypeOf(parsed.answers), Object.prototype);
});

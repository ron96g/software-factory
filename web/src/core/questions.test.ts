import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeQuestions, questionId, DEFAULT_BLOCKER_OPTIONS } from "./questions.ts";

describe("normalizeQuestions", () => {
  it("AC-1: strings are non-blockers with stable ids", () => {
    const [q] = normalizeQuestions(["Which DB?"]);
    assert.equal(q.blocker, false);
    assert.equal(q.id, questionId("which  db?"));
  });
  it("AC-2: blockers get default options, supplied options kept", () => {
    const [a, b] = normalizeQuestions([{ text: "x", blocker: true }, { id: "k", text: "y", blocker: true, options: ["A", "B"] }]);
    assert.deepEqual(a.options, DEFAULT_BLOCKER_OPTIONS);
    assert.deepEqual([b.id, b.options], ["k", ["A", "B"]]);
  });
});

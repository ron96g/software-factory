import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const read = (n: string) => readFileSync(new URL(`../../../agents/${n}.md`, import.meta.url), "utf8");

it("AC-4 triager only blocks for flagged blockers with options and defers the rest", () => {
  const t = read("triager");
  assert.match(t, /true human-only blockers/);
  assert.match(t, /blocker: true/);
  assert.match(t, /Defer every other question/);
});

it("AC-4 planner never repeats settled upstream questions", () => {
  const p = read("planner");
  assert.match(p, /Never repeat settled upstream questions/);
  assert.match(p, /answersQuestionIds/);
});

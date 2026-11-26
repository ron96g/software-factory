import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineProblem, parseDiffLines } from "./diff-lines.ts";

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function f() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
@@ -40,2 +41,2 @@
 x();
-y();
+z();
\\ No newline at end of file
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone();
-also();
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one();
+two();
`;

test("RIGHT lines are added or context lines of the head inside hunks, LEFT the base side", () => {
  const d = parseDiffLines(patch);
  assert.deepEqual([...d.right.get("src/a.ts")!].sort((a, b) => a - b), [10, 11, 12, 13, 41, 42]);
  assert.deepEqual([...d.left.get("src/a.ts")!].sort((a, b) => a - b), [10, 11, 12, 40, 41]);
  assert.equal(d.right.get("old.ts"), undefined, "a deleted file has no head lines");
  assert.deepEqual([...d.left.get("old.ts")!], [1, 2]);
  assert.deepEqual([...d.right.get("new.ts")!], [1, 2]);
});

test("a finding is inline-able only when every line of its range is in a hunk on its side", () => {
  const d = parseDiffLines(patch);
  assert.equal(inlineProblem(d, { path: "src/a.ts", line: 12 }), undefined);
  assert.equal(inlineProblem(d, { path: "src/a.ts", startLine: 10, line: 13 }), undefined);
  assert.match(inlineProblem(d, { path: "src/a.ts", startLine: 13, line: 41 })!, /src\/a\.ts:14 is outside/);
  assert.match(inlineProblem(d, { path: "src/a.ts", line: 20 })!, /outside the changed hunks/);
  assert.equal(inlineProblem(d, { path: "old.ts", line: 2, side: "LEFT" }), undefined);
  assert.match(inlineProblem(d, { path: "old.ts", line: 2 })!, /no added or context lines/);
  assert.match(inlineProblem(d, { path: "src/a.ts", startLine: 13, line: 12 })!, /startLine is after line/);
  assert.match(inlineProblem(d, { path: "README.md" })!, /no line/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_TOOLS, readRange } from "./sandbox-tools.ts";
import { MAX_RESULT, parseMarker } from "./truncation.ts";

const big = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n");

test("read_file paging: startLine returns that line, bounded, with continuation", () => {
  const r = readRange(big, 500);
  assert.match(r, /^lines 500-\d+ of 2000\n500: line 500/);
  assert.ok(r.length <= MAX_RESULT);
  const m = parseMarker(r);
  assert.equal(m?.tool, "read_file");
  assert.match(m!.next, /^startLine=\d+$/);
});

test("read_file ranges: edge cases", () => {
  assert.throws(() => readRange("a\nb", 5), /beyond end of file \(file has 2 lines\)/);
  assert.throws(() => readRange("a\nb", 2, 1), /before startLine/);
  assert.equal(readRange("", 1), "lines 0 of 0 (empty file)");
  assert.equal(readRange("a\r\nb\r\n", 1, 2), "lines 1-2 of 2\n1: a\n2: b");
  const long = readRange(`${"y".repeat(20_000)}\nnext`, 1);
  assert.ok(long.length <= MAX_RESULT);
  assert.match(long, /note: line 1 is longer than the output cap; \d+ chars omitted/);
});

test("read_file rejects invalid numbers; other tools emit marker", async () => {
  const caps = { read: { readFile: async () => "a", listFiles: async () => Array.from({ length: 5000 }, (_, i) => `file${i}.ts`) } } as never;
  const rf = SANDBOX_TOOLS.find((t) => t.name === "read_file")!.bind!(caps);
  await assert.rejects(rf.invoke({ path: "a", startLine: 1.5 }), /integer/);
  await assert.rejects(rf.invoke({ path: "a", startLine: -1 }), /integer/);
  const lf = await SANDBOX_TOOLS.find((t) => t.name === "list_files")!.bind!(caps).invoke({});
  assert.ok(lf.length <= MAX_RESULT);
  assert.equal(parseMarker(lf)?.tool, "list_files");
});

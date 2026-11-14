import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeSourceAccess } from "./access.ts";

test("AC-1: access defaults to read-only", () => {
  assert.equal(knowledgeSourceAccess({}), "read-only");
  assert.equal(knowledgeSourceAccess({ access: "read-only" }), "read-only");
});
test("AC-1: other access values are rejected", () => {
  assert.throws(() => knowledgeSourceAccess({ access: "managed" } as never));
  assert.throws(() => knowledgeSourceAccess({ access: "" } as never));
});

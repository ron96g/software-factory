import test from "node:test";
import assert from "node:assert/strict";
import { factoryTools } from "./exposed/factory-tools.ts";

test("AC-6: propose_issue requires workItem", async () => {
  const tool = factoryTools({} as never).find((t) => t.name === "propose_issue")!;
  assert.ok((tool.inputSchema as { required: string[] }).required.includes("workItem"));
  await assert.rejects(() => tool.invoke({} as never, { title: "t", body: "b" } as never));
});

test("U5-O2: MCP offers propose_issue and list_issue_targets, but no create or approve issue tool", () => {
  const names = factoryTools({} as never).map((t) => t.name);
  assert.ok(names.includes("propose_issue") && names.includes("list_issue_targets"));
  assert.deepEqual(names.filter((n) => /issue/.test(n) && /create|approve|delete|resolve/.test(n)), []);
});

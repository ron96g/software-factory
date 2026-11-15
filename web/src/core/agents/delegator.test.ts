import { test } from "node:test";
import assert from "node:assert/strict";
import { capChildTools, DefaultDelegator, SPAWN_SUBAGENT } from "./delegator.ts";

test("U3: child tools are the intersection with the parent's; no spawn/finish", () => {
  assert.deepEqual(capChildTools(["read_file", "search_code"], ["read_file", "write_file", SPAWN_SUBAGENT.name, "finish"]), ["read_file"]);
  assert.deepEqual(capChildTools(["a"], undefined), []);
});

test("U3: depth is limited to 1", async () => {
  const d = new DefaultDelegator({} as never);
  const parent = { metadata: { name: "p" }, spec: { parentRunRef: { name: "root" } } } as never;
  await assert.rejects(() => d.delegate(parent, "x", "q"), /max depth 1/);
});

test("U3: creates a child run with parentRunRef and capped tools", async () => {
  const created: any[] = [];
  const statuses: any[] = [];
  const agent = { metadata: { name: "child", namespace: "ns" }, spec: { role: "r", tools: ["read_file", "write_file"] }, body: "b" };
  const d = new DefaultDelegator({
    reader: { get: async () => agent, list: async () => [] } as never,
    writer: { create: async (o: any) => { created.push(o); return o; } } as never,
    status: { updateStatus: async (o: any) => { statuses.push(o); return o; } } as never,
    recorders: { forRun: async () => ({ ref: { namespace: "", id: "" }, record: async () => {} }) } as never,
    executor: () => ({ name: "x", canExecute: () => true, execute: async (c: any) => ({ summary: `ran ${c.agent.spec.tools}` }) }),
    workspaces: {} as never,
    redactor: { redact: (s: string) => s } as never,
  });
  const parent = { metadata: { name: "p", namespace: "ns" }, spec: { agentRef: { name: "p" }, skillRefs: [], inputs: [], outputs: [] } } as never;
  const ctx = { agent: { spec: { tools: ["read_file"] } }, repositories: [], sections: [] } as never;
  const r = await d.delegate(parent, "child", "why?", ctx);
  assert.equal(r.summary, "ran read_file");
  assert.equal(created[0].spec.parentRunRef.name, "p");
  assert.deepEqual(created[0].spec.tools, ["read_file"]);
  assert.equal(statuses.at(-1).status.phase, "Succeeded");
});

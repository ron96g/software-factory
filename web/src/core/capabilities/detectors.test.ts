import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_CAPABILITY_DETECTORS as D } from "./detectors.ts";
import type { CapabilityFacts, CompiledWorkflow } from "../ports/index.ts";
import type { CheckRun, OutboxMessage, Source, WorkItem } from "../model/kinds.ts";

const item = (spec: Partial<WorkItem["spec"]> = {}) => ({ kind: "WorkItem", metadata: { name: "i" }, spec: { title: "t", sourceRef: { name: "s" }, ...spec } }) as WorkItem;
const workflow = (w: Partial<CompiledWorkflow> = {}) => ({ name: "w", stages: [], ...w }) as unknown as CompiledWorkflow;
const facts = (f: Partial<CapabilityFacts> = {}): CapabilityFacts => ({ workItem: item(), runs: [], checkRuns: [], outbox: [], ...f });
const outbox = (action: string) => [{ spec: { action, payload: {} } }] as unknown as OutboxMessage[];
const holds = (name: string, f: CapabilityFacts) => D[name].detect(f);

test("ADR-0075: a workflow without code features declares no code capabilities", () => {
  const f = facts({ workflow: workflow({ stages: [{ name: "respond", lifecyclePhase: "operations", origin: "w", steps: [] }] as never }) });
  for (const name of ["planning", "verification", "checks", "unit-execution", "pull-requests", "ticket-actions", "retrospective"]) assert.equal(holds(name, f), false, name);
});

test("ADR-0075: declared by the workflow", () => {
  const f = facts({ workflow: workflow({ verification: {} as never, planning: {} as never, unitExecution: {} as never,
    stages: [{ name: "ship", lifecyclePhase: "operations", origin: "w", steps: [], publish: { pullRequest: { draft: true } } }] as never }) });
  for (const name of ["planning", "verification", "checks", "unit-execution", "pull-requests"]) assert.equal(holds(name, f), true, name);
  assert.equal(holds("checks", facts({ workflow: workflow({ stages: [{ name: "verify", lifecyclePhase: "construction", origin: "w", steps: [], gate: { type: "automated", checks: ["build"] } }] as never }) })), true);
});

test("ADR-0075: used but no longer declared keeps the capability, so history stays visible", () => {
  assert.equal(holds("checks", facts({ checkRuns: [{}] as CheckRun[] })), true);
  assert.equal(holds("pull-requests", facts({ outbox: outbox("open-pull-request") })), true);
  assert.equal(holds("ticket-actions", facts({ outbox: outbox("service-desk-reply") })), true);
  assert.equal(holds("ticket-actions", facts({ outbox: outbox("ticket-transition") })), true);
  assert.equal(holds("unit-execution", facts({ runs: [{ spec: { assignment: { kind: "unit", unit: "U1" } } }] as never })), true);
  assert.equal(holds("checks", facts({ outbox: outbox("comment") })), false);
});

test("ADR-0075: ticket actions need a synced item and a Source with reviewed write-back", () => {
  const source = (writeBack?: Source["spec"]["writeBack"]) => ({ spec: { type: "jira", writeBack } }) as Source;
  const synced = item({ externalRef: { id: "SD-1" } });
  assert.equal(holds("ticket-actions", facts({ workItem: synced, source: source({ replyVisibilities: ["public"] }) })), true);
  assert.equal(holds("ticket-actions", facts({ workItem: synced, source: source({ transitions: true }) })), true);
  assert.equal(holds("ticket-actions", facts({ workItem: synced, source: source() })), false, "read-only source");
  assert.equal(holds("ticket-actions", facts({ source: source({ transitions: true }) })), false, "not synced");
});

test("ADR-0075: retrospective items", () => {
  assert.equal(holds("retrospective", facts({ workItem: item({ retrospective: {} as never }) })), true);
});

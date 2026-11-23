import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createFactory, type Factory } from "../core/factory.ts";
import { testDefinitions } from "../core/testing/definitions.ts";
import { ANONYMOUS as p, type WorkItemDetail } from "../core/ports/index.ts";
import type { IssueProposal } from "../core/model/kinds.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const detail = (f: Factory, name: string) => f.app.getWorkItem(p, name) as Promise<WorkItemDetail>;

test("X57 story-refinement (ADR-0077)", async (t) => {
  const created: { summary: string; description: string }[] = [];
  let drafts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.host === "jira.telekom.de") {
      if (init?.method === "POST" && u.pathname === "/rest/api/2/issue") {
        const fields = JSON.parse(String(init.body)).fields;
        created.push({ summary: fields.summary, description: fields.description });
        return Response.json({ id: "10", key: "DHEI-42", self: "https://jira.telekom.de/rest/api/2/issue/10" });
      }
      return Response.json({ key: "DHEI-42", fields: { status: { name: "Open", statusCategory: { key: "new" } }, updated: "2026-11-20T10:00:00.000+0000" } });
    }
    const body = JSON.parse(String(init?.body));
    const system = String(body.messages[0].content);
    const research = { summary: "researched", artifacts: [{ type: "research-notes", content: "## Summary\nReady is set in `controlplane:internal/status.go:42`." }], questions: [] };
    if (body.tools) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "f", type: "function", function: { name: "finish", arguments: JSON.stringify(research) } }] } }] });
    }
    if (system.includes("## Skill: codebase-research")) return Response.json({ choices: [{ message: { content: JSON.stringify(research) } }] });
    if (system.includes("## Skill: ticket-writing")) {
      drafts++;
      const ticket = { title: `Show only real failures to customers v${drafts}`, body: `## Problem\nA failed no-op reconcile is shown to customers as an error (draft ${drafts}).\n\n## Acceptance criteria\n1. **Given** a no-op, **when** it fails, **then** customers see no error.` };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "drafted", artifacts: [{ type: "ticket-draft", content: JSON.stringify(ticket) }], questions: [] }) } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "ok", artifacts: [], questions: [] }) } }] });
  }) as typeof fetch;
  const f = await createFactory({ definitionsRoot: ROOT, definitionLoader: testDefinitions(), databasePath: ":memory:", fetch: fetchImpl, log: () => {},
    env: { FACTORY_AGENT_RUNTIME: "tool-loop", OPENAI_API_KEY: "sk-test-123456", JIRA_TOKEN: "jira-test-token", FACTORY_PUBLIC_URL: "https://factory.example" } });
  await f.start();
  try {
    await t.test("AC-1: New item offers the workflow with its tracker; no mirror, only permitted targets", async () => {
      const options = await f.app.newItemOptions(p);
      assert.deepEqual(options.workflows.find((w) => w.name === "story-refinement")?.publishesTicket, { target: "jira-main" });
      await assert.rejects(f.app.createWorkItem(p, { title: "x", workflowRef: "story-refinement", mirrorTo: "jira-main" }), /publishes the ticket itself/);
      await assert.rejects(f.app.createWorkItem(p, { title: "x", workflowRef: "story-refinement", ticketTarget: "jira-servicedesk" }), /does not permit creating issues/);
    });

    let name = "";
    let d: WorkItemDetail;
    await t.test("AC-2: the code is researched and the product owner's story waits for human review; a rejection is redrafted", async () => {
      const wi = await f.app.createWorkItem(p, { title: "Customer-visible errors", description: "A failed no-op reconcile is shown to customers.", workflowRef: "story-refinement", ticketTarget: "jira-main" });
      name = wi.metadata.name;
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.stage === "story-review" && x.workItem.status.phase === "AwaitingApproval" && x; }, "story-review");
      assert.deepEqual(d.stages.map((s) => s.name), ["research", "refine", "story-review", "publish-ticket"]);
      assert.ok(d.artifacts.some((a) => a.spec.artifactTypeRef.name === "research-notes"));
      assert.equal(created.length, 0, "nothing is published before the human approves");

      await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "reject", "Add a regression criterion");
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.phase === "AwaitingApproval" && x.approvals.length === 2 && x; }, "second review");
      assert.equal(drafts, 2, "the product owner redrafted after the rejection");
    });

    await t.test("AC-3: approval publishes exactly the approved draft once, with the factory link; the item is Done", async () => {
      await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "approve");
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.phase === "Done" && x; }, "Done after publication");

      assert.equal(created.length, 1);
      assert.equal(created[0].summary, "Show only real failures to customers v2", "the approved (second) draft is published");
      assert.match(created[0].description, /draft 2[\s\S]*Factory work item: https:\/\/factory\.example\/items\//);
      const ticket = d.issues.find((i) => i.spec.purpose === "story") as IssueProposal;
      assert.equal(ticket.metadata.name, `${name}-ticket`);
      assert.equal(ticket.status?.externalRef?.externalId, "DHEI-42");
      assert.equal(ticket.spec.provenance?.approval, d.approvals.find((a) => a.spec.decision === "approve")!.metadata.name);
      const second = d.artifacts.filter((a) => a.spec.artifactTypeRef.name === "ticket-draft").sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? "")).at(-1)!;
      assert.equal(ticket.spec.provenance?.artifact?.uid, second.metadata.uid);

    });

    await t.test("AC-4: Start implementation creates the linked item with the story's research", async () => {
      const ticket = d.issues.find((i) => i.spec.purpose === "story") as IssueProposal;
      const impl = await f.app.startImplementation(p, ticket.metadata.name);
      assert.equal(impl.metadata.name, "jira-main-dhei-42");
      assert.equal(impl.spec.originWorkItemRef?.name, name);
      assert.match(impl.spec.originSnapshot?.content ?? "", /status\.go:42/, "the implementation starts from the story's research");

    });

    await t.test("AC-5: a restart that produces a new draft never edits or duplicates the created ticket", async () => {
      await f.app.restartWorkItem(p, name, "refine");
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.phase === "AwaitingApproval" && x.workItem.status.stage === "story-review" && x.approvals.length === 3 && x; }, "review after restart");
      await f.app.decideApproval(p, d.workItem.status!.blockedBy!.name, "approve");
      d = await waitFor(async () => { const x = await detail(f, name); return x.workItem.status?.phase === "Waiting" && x; }, "Waiting with a reason");
      assert.match(d.workItem.status?.message ?? "", /^Publication: this item already published DHEI-42; the factory never edits a created ticket/);
      assert.equal(created.length, 1);
    });
  } finally { await f.stop(); }
});

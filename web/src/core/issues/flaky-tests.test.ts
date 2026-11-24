import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../store/sqlite-store.ts";
import { StoreEventRecorder } from "../runtime/event-recorder.ts";
import { API_VERSION } from "../model/resource.ts";
import type { FactoryEvent, IssueProposal, Repository, WorkItem } from "../model/kinds.ts";
import { EventFlakyTestReporter, FLAKY_TEST_EVENT } from "./flaky-tests.ts";

test("ADR-0086 §6: one event per flaky decision; the third decision for a test proposes one issue to the repository's tracker", async () => {
  const db = new DatabaseSync(":memory:");
  const clock = { now: () => new Date("2026-11-20T12:00:00Z") };
  const store = new SqliteStore(db, clock);
  try {
    await store.create<Repository>({ apiVersion: API_VERSION, kind: "Repository", metadata: { name: "repo", namespace: "factory-system" },
      spec: { issueTrackerRef: { name: "jira-main" } } as Repository["spec"] });
    const items = await Promise.all(["a", "b"].map((name) => store.create<WorkItem>({ apiVersion: API_VERSION, kind: "WorkItem",
      metadata: { name, namespace: "default" }, spec: { title: name, sourceRef: { name: "manual" } } })));
    const reporter = new EventFlakyTestReporter({ reader: store, writer: store, events: new StoreEventRecorder(store), clock, redactor: { redact: (t) => t } });
    const flakyEvents = async () => (await store.list<FactoryEvent>("Event", { namespace: "default" })).filter((e) => e.spec.reason === FLAKY_TEST_EVENT);
    const proposals = () => store.list<IssueProposal>("IssueProposal", { namespace: "default" });

    await reporter.report(items[0], "repo/unit-tests", { tests: ["cleanup"], runs: ["c1", "c2"] });
    await reporter.report(items[0], "repo/unit-tests", { tests: ["cleanup"], runs: ["c1", "c2"] });
    assert.equal((await flakyEvents()).length, 1, "reporting the same decision again records nothing");
    await reporter.report(items[0], "repo/unit-tests", { tests: ["cleanup"], runs: ["c3", "c4"] });
    assert.equal((await proposals()).length, 0, "two decisions are not yet a pattern");
    await reporter.report(items[1], "repo/unit-tests", { tests: ["cleanup", "other"], runs: ["d1", "d2"] });
    const [proposal] = await proposals();
    assert.equal((await proposals()).length, 1);
    assert.equal(proposal.spec.title, "Flaky test: cleanup");
    assert.equal(proposal.spec.targetRef?.name, "jira-main");
    assert.equal(proposal.spec.purpose, "finding");
    assert.equal(proposal.spec.review, undefined, "a human decides whether it is created");
    assert.match(proposal.spec.body, /3 times in the last 7 days/);
    await reporter.report(items[1], "repo/unit-tests", { tests: ["cleanup"], runs: ["d3", "d4"] });
    assert.equal((await proposals()).length, 1, "proposed once per test");
  } finally { db.close(); }
});

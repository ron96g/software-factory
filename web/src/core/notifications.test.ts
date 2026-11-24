import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { API_VERSION, type Resource } from "./model/resource.ts";
import type { FactoryEvent, WorkItem } from "./model/kinds.ts";
import { ownerRef } from "./model/meta.ts";
import { ANONYMOUS, type NotificationRule } from "./ports/index.ts";
import { SecretRedactor } from "./transcripts/recorder.ts";
import { Registry } from "./registry/registry.ts";
import { SqliteStore } from "./store/sqlite-store.ts";
import { StoreEventRecorder } from "./runtime/event-recorder.ts";
import { EventNotificationFeed, RuleBasedNotificationClassifier } from "./notifications/classifier.ts";
import { registerNotificationRules } from "./notifications/rules.ts";

async function setup(redactor = new SecretRedactor()) {
  let t = Date.parse("2026-11-19T10:00:00Z");
  const clock = { now: () => new Date((t += 1000)) };
  const store = new SqliteStore(new DatabaseSync(":memory:"), clock);
  const rules = new Registry<NotificationRule>();
  registerNotificationRules(rules);
  const classifier = new RuleBasedNotificationClassifier({ rules, reader: store, redactor });
  const feed = new EventNotificationFeed({ reader: store, classifier });
  const events = new StoreEventRecorder(store);
  const wi = await store.create<WorkItem>({
    apiVersion: API_VERSION,
    kind: "WorkItem",
    metadata: { name: "wi-1", namespace: "default" },
    spec: { title: "Fix login", sourceRef: { name: "manual" } },
  });
  const latest = async () => {
    const all = await store.list<FactoryEvent>("Event");
    return all.sort((a, b) => a.metadata.creationTimestamp!.localeCompare(b.metadata.creationTimestamp!)).at(-1)!;
  };
  const child = (kind: string, name: string): Resource => ({ apiVersion: API_VERSION, kind, metadata: { name, namespace: "default", uid: `uid-${name}`, ownerReferences: [ownerRef(wi)] }, spec: {} });
  return { store, classifier, feed, events, wi, latest, child };
}

test("an action event becomes a notification linked to its work item", async () => {
  const { classifier, events, wi, latest } = await setup();
  await events.normal(wi, "Blocked", "spec: waiting for clarification");
  const ev = await latest();
  const n = await classifier.classify(ev);
  assert.deepEqual(n, {
    id: ev.metadata.uid,
    at: ev.metadata.creationTimestamp,
    namespace: "default",
    severity: "action",
    category: "clarification",
    title: "Clarification needed",
    message: "Fix login: spec: waiting for clarification",
    link: "/items/wi-1",
    workItem: "wi-1",
    subject: "Fix login",
  });
});

test("uncatalogued reasons never notify; wildcard rules match any kind", async () => {
  const { classifier, events, wi, latest, child } = await setup();
  await events.normal(wi, "StageStarted", "implement");
  assert.equal(await classifier.classify(await latest()), null);
  await events.warning(child("AgentRun", "run-1"), "ReconcileFailing", "agentrun: attempt 3 failed: boom");
  const n = await classifier.classify(await latest());
  assert.equal(n?.severity, "problem");
  assert.equal(n?.link, "/items/wi-1");
});

test("only pull-request deliveries notify, linking to the PR; syncs only with new items", async () => {
  const { classifier, events, latest, child } = await setup();
  await events.normal(child("OutboxMessage", "m-1"), "Delivered", "comment → github#4");
  assert.equal(await classifier.classify(await latest()), null);
  await events.normal(child("OutboxMessage", "m-2"), "Delivered", "open-pull-request · https://github.com/o/r/pull/7");
  const pr = await classifier.classify(await latest());
  assert.equal(pr?.link, "https://github.com/o/r/pull/7");

  const source: Resource = { apiVersion: API_VERSION, kind: "Source", metadata: { name: "github", namespace: "default", uid: "def-github" }, spec: {} };
  await events.normal(source, "Synced", "0 created, 3 updated");
  assert.equal(await classifier.classify(await latest()), null);
  await events.normal(source, "Synced", "2 created, 0 updated");
  assert.equal((await classifier.classify(await latest()))?.title, "New work items");
});

test("X63: a check that produced no evidence notifies; an ordinary failure stays in the timeline", async () => {
  const { classifier, events, latest, child } = await setup();
  await events.warning(child("CheckRun", "check-1"), "CheckCompleted", "UnknownFailure: security-scan: UnknownFailure (exit 1 in 900 ms)");
  assert.equal(await classifier.classify(await latest()), null, "a real failure is not a tooling gap");
  await events.warning(child("CheckRun", "check-2"), "CheckCompleted", "Unavailable: review-scope: Unavailable (exit 127 in 12 ms)");
  const n = await classifier.classify(await latest());
  assert.equal(n?.severity, "problem");
  assert.equal(n?.category, "checks");
  assert.equal(n?.title, "A check could not run");
  assert.equal(n?.link, "/items/wi-1");
  assert.match(n!.message, /^Fix login: review-scope: Unavailable/, "the outcome prefix is stripped and the item is named");
});

test("the feed lists notifications newest first, from `since` (inclusive), up to `limit`", async () => {
  const { feed, events, wi, latest } = await setup();
  await events.normal(wi, "Blocked", "a");
  const first = await latest();
  await events.normal(wi, "StageStarted", "ignored");
  await events.normal(wi, "AwaitingApproval", "b");
  await events.normal(wi, "Completed", "c");

  assert.deepEqual((await feed.listNotifications(ANONYMOUS, {})).map((n) => n.title), ["Work item done", "Approval needed", "Clarification needed"]);
  assert.deepEqual((await feed.listNotifications(ANONYMOUS, { since: first.metadata.creationTimestamp })).map((n) => n.category), ["done", "approval", "clarification"]);
  assert.deepEqual((await feed.listNotifications(ANONYMOUS, { since: (await latest()).metadata.creationTimestamp })).map((n) => n.category), ["done"]);
  assert.equal((await feed.listNotifications(ANONYMOUS, { limit: 1 })).length, 1);
});

test("secrets in event messages are redacted before they reach a notification", async () => {
  const redactor = new SecretRedactor();
  redactor.add("fake-secret-value-123");
  const { classifier, events, wi, latest } = await setup(redactor);
  await events.warning(wi, "AgentRunFailed", "run-1: push failed: https://x:fake-secret-value-123@github.com");
  const n = await classifier.classify(await latest());
  assert.ok(n && !n.message.includes("fake-secret-value-123") && n.message.includes("«redacted»"));
});

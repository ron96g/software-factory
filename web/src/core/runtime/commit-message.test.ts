import assert from "node:assert/strict";
import { test } from "node:test";
import { conventionalCommits, plainCommitMessage } from "./commit-message.ts";

test("ADR-0092: the conventional format derives the type from the classification and keeps the work-item trailer", () => {
  assert.equal(conventionalCommits.format({ title: "Add file download proxy.", workItem: "w1", classification: "feature" }), "feat: Add file download proxy\n\nWork item: w1");
  assert.equal(conventionalCommits.format({ title: "Crash on empty list", workItem: "w2", classification: "Bug" }), "fix: Crash on empty list\n\nWork item: w2");
  assert.equal(conventionalCommits.format({ title: "Something", workItem: "w3" }), "feat: Something\n\nWork item: w3", "unknown classification: a feature");
  assert.equal(conventionalCommits.format({ title: "fix(api): keep\n the prefix", workItem: "w4" }), "fix(api): keep the prefix\n\nWork item: w4", "an existing prefix is kept, on one line");
  assert.equal(conventionalCommits.format({ title: "update: the README", workItem: "w5" }), "feat: update: the README\n\nWork item: w5", "an unknown word is not a type");
});

test("ADR-0023: without a convention the message stays title + work-item trailer", () => {
  assert.equal(plainCommitMessage({ title: "Item title", workItem: "item" }), "Item title\n\nWork item: item");
});

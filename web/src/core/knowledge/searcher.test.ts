import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultKnowledgeSearcher } from "./searcher.ts";

const entry = (name: string, phase: string, decision: string | undefined, content = "deploy secret-token") => ({
  metadata: { name },
  spec: { title: `deploy ${name}`, content, tags: [], review: decision ? { decision } : undefined },
  status: { phase },
});
const source = { metadata: { name: "docs" }, spec: { type: "files" } };

const make = (entries: unknown[]) =>
  new DefaultKnowledgeSearcher({
    reader: { list: async (kind: string) => (kind === "KnowledgeEntry" ? entries : [source]) },
    sources: { get: () => ({ search: async () => [{ kind: "doc", title: "doc deploy", ref: "d", excerpt: "deploy secret-token" }] }) },
    redactor: { redact: (s: string) => s.replace("secret-token", "[redacted]") },
  } as never);

test("AC-2: entry and doc hits stay distinguishable", async () => {
  const hits = await make([entry("a", "Approved", "approve")]).searchKnowledge({ terms: ["deploy"] });
  assert.deepEqual(hits.map((h) => h.kind), ["entry", "doc"]);
});

test("AC-3: only approved entries are served", async () => {
  const hits = await make([
    entry("p", "Proposed", undefined),
    entry("r", "Approved", "reject"),
    entry("ok", "Approved", "approve"),
  ]).searchKnowledge({ terms: ["deploy"] });
  assert.deepEqual(hits.filter((h) => h.kind === "entry").map((h) => h.ref), ["ok"]);
});

test("AC-3: ADR-0015 redaction applies to entries and docs", async () => {
  const hits = await make([entry("ok", "Approved", "approve")]).searchKnowledge({ terms: ["deploy"] });
  for (const h of hits) assert.ok(!h.excerpt.includes("secret-token"));
});

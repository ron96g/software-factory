import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoDefinitions, mergeCatalog, parseDefinition, parseFrontmatter } from "./definitions.ts";

test("parses frontmatter scalars and lists; malformed is null", () => {
  const fm = parseFrontmatter("---\nname: x\ntools: [a, b]\nmodel: m\n---\nbody");
  assert.deepEqual(fm?.data, { name: "x", tools: ["a", "b"], model: "m" });
  assert.equal(fm?.body, "body");
  assert.equal(parseFrontmatter("no frontmatter"), null);
  assert.equal(parseDefinition("agent", "f", "p", "---\n???\n---\n"), null);
  assert.equal(parseDefinition("skill", "fallback", "p", "---\ndescription: d\n---\nb")?.name, "fallback");
});

test("loads from all sources, skips malformed, factory wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "defs-"));
  for (const d of [".software_factory/agents", ".agents/skills/s1", ".github/agents", ".opencode/agents"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, ".software_factory/agents/a.md"), "---\nname: a\ndescription: da\n---\nBODY");
  writeFileSync(join(root, ".agents/skills/s1/SKILL.md"), "---\nname: s1\ndescription: ds\n---\nB");
  writeFileSync(join(root, ".github/agents/bad.md"), "garbage");
  writeFileSync(join(root, ".opencode/agents/o.md"), "---\ndescription: od\n---\nB");
  const all = await loadRepoDefinitions(root);
  assert.deepEqual(all.map((e) => e.name).sort(), ["a", "o", "s1"]);
  const merged = mergeCatalog(all, { agent: new Set(["a"]), skill: new Set() });
  assert.deepEqual(merged.map((e) => e.name).sort(), ["o", "s1"]);
});

import { test as t2 } from "node:test";
import assert2 from "node:assert/strict";
import { skillRequester, REQUEST_SKILL } from "./definitions.ts";

t2("U2 request_skill: factory skill body returned only on request, capped", async () => {
  const reader = { list: async () => [{ metadata: { name: "kb" }, body: "x".repeat(20000) }], get: async () => null } as never;
  const r = skillRequester({ checkout: async () => "/nonexistent" } as never, reader, { redact: (s: string) => s } as never);
  const out = await r.request({ repositories: [] } as never, "kb");
  assert2.ok(out.length < 8300 && out.endsWith("[truncated]"));
  assert2.equal(await r.request({ repositories: [] } as never, "nope"), 'skill "nope" not found');
  assert2.equal(REQUEST_SKILL.name, "request_skill");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { repoContextProvider } from "./repo-context.ts";

async function run(files: Record<string, string>, skills: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "rc-"));
  for (const [p, c] of Object.entries(files)) { await mkdir(join(root, p, ".."), { recursive: true }); await writeFile(join(root, p), c); }
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, stdio: "ignore" });
  g("init"); g("add", "-A"); g("commit", "--allow-empty", "-m", "x");
  const rec: any[] = [];
  const ctx: any = {
    agent: { metadata: { name: "dev" } }, skills: skills.map((n) => ({ metadata: { name: n } })), workspaces: [],
    repositories: [{ metadata: { name: "r" } }], transcript: { record: async (r: any) => { rec.push(r); } },
  };
  const p = repoContextProvider({ checkout: async () => root } as any, { redact: (t: string) => t.replace("SECRETVAL", "***") } as any);
  return { out: await p.provide(ctx), rec, p, ctx };
}

test("AC-1/3/5 sections capped, redacted, recorded", async () => {
  const { out, rec } = await run({ ".software_factory/skills/a.md": "hi SECRETVAL", ".agents/skills/b/SKILL.md": "---\nname: bee\n---\n" + "x".repeat(9000) });
  assert.equal(out.length, 2);
  assert.ok(!out[0]!.content.includes("SECRETVAL"));
  assert.ok(out[1]!.content.length < 8192 + 300);
  assert.match(JSON.parse(rec[0].content).commit, /^[0-9a-f]{40}$/);
  assert.match(rec[0].content, /\.agents\/skills\/b\/SKILL\.md/);
});
test("AC-2 collision skipped", async () => {
  const { out } = await run({ ".software_factory/agents/dev.md": "x" });
  assert.equal(out.length, 0);
});
test("AC-4 no dirs", async () => {
  const { out } = await run({});
  assert.equal(out.length, 0);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitWorkingTreeDiff } from "./module-scope.ts";
import type { Workspace } from "../../model/kinds.ts";

test("SEC-2: the candidate diff covers the whole working tree and runs no filter or diff driver from the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-diff-"));
  const pwned = join(dir, "..", `pwned-${process.pid}`);
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
    git("init", "-q");
    git("config", "user.email", "t@t"); git("config", "user.name", "t");
    writeFileSync(join(dir, "kept.txt"), "one\n");
    writeFileSync(join(dir, "gone.txt"), "bye\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    // A developer agent can write all of this in its workspace.
    git("config", "filter.evil.clean", `touch ${pwned}; cat`);
    git("config", "diff.evil.textconv", `touch ${pwned}; cat`);
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(dir, "kept.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    rmSync(join(dir, "gone.txt"));
    git("add", "new.txt"); // staged, plus unstaged and untracked changes below
    writeFileSync(join(dir, "untracked.txt"), "loose\n");
    const indexBefore = git("ls-files", "--stage");
    rmSync(pwned, { force: true }); // the setup's own `git add` ran the filter; only the factory's diff counts

    const ws = { metadata: { name: "w" }, status: { path: dir, baseCommit: base } } as unknown as Workspace;
    const { patch, truncated } = await new GitWorkingTreeDiff().diff(ws, 1 << 20);
    assert.equal(truncated, false);
    assert.equal(existsSync(pwned), false, "no workspace-defined filter or diff driver ran");
    assert.match(patch, /\+two/);
    assert.match(patch, /new file mode[\s\S]*\+fresh/);
    assert.match(patch, /deleted file mode[\s\S]*-bye/);
    assert.match(patch, /untracked\.txt[\s\S]*\+loose/);
    assert.equal(git("ls-files", "--stage"), indexBefore, "the workspace index is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pwned, { force: true });
  }
});

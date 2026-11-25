import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapEnvironment, buildBwrapArgs, resolverBinds, sandboxEnv, sandboxHome, shellQuote } from "./bwrap.ts";
import { CandidateCommitRejectedError, canConfineShell, canPrepareIsolated, TOOLCHAIN_MOUNT, type CommitHookSetup, type SandboxSpec } from "../../ports/index.ts";

/** A dangling `/etc/resolv.conf` symlink leaves the sandbox without DNS, so its target must be bound too. */
test("ADR-0081 §3: a symlinked resolv.conf has its target bound; a real file needs no extra bind", () => {
  const exists = () => true;
  assert.deepEqual(resolverBinds(exists, "/etc/resolv.conf", () => "/mnt/wsl/resolv.conf"), ["/mnt/wsl/resolv.conf"], "WSL");
  assert.deepEqual(resolverBinds(exists, "/etc/resolv.conf", () => "/run/systemd/resolve/stub-resolv.conf"), ["/run/systemd/resolve/stub-resolv.conf"], "systemd-resolved");
  assert.deepEqual(resolverBinds(exists, "/etc/resolv.conf", () => "/etc/resolv.conf"), [], "a regular file is already inside /etc");
  assert.deepEqual(resolverBinds(() => false, "/etc/resolv.conf", () => "/mnt/wsl/resolv.conf"), [], "a missing target is not bound");
  assert.deepEqual(resolverBinds(exists, "/etc/resolv.conf", () => { throw new Error("ENOENT"); }), [], "no resolv.conf at all");
});

test("ADR-0079: buildBwrapArgs confines filesystem to workspace, uses ephemeral HOME, and keeps network", () => {
  const workspace = "/tmp/fake-workspaces/item-1/repo";
  const cwd = "/tmp/fake-workspaces/item-1/repo/subdir";
  const args = buildBwrapArgs({
    workspace,
    cwd,
    command: "npm test",
    extraRoBinds: ["/custom/toolchain"],
    exists: (p) => ["/usr", "/lib", "/bin", "/etc", "/custom/toolchain"].includes(p),
  });

  // Read-only OS & toolchain binds only
  assert.ok(args.includes("--ro-bind"));
  const roBinds: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--ro-bind") roBinds.push(args[i + 1]);
  assert.deepEqual(roBinds, ["/usr", "/lib", "/bin", "/etc", "/custom/toolchain"]);
  assert.ok(!roBinds.includes(process.env.HOME ?? ""), "host HOME is never bound");

  // Ephemeral /tmp and HOME, rw workspace only, PID isolation + network kept
  const joined = args.join(" ");
  assert.match(joined, /--tmpfs \/tmp --tmpfs \/tmp\/home/);
  assert.match(joined, new RegExp(`--bind ${workspace} ${workspace}`));
  assert.match(joined, new RegExp(`--chdir ${cwd}`));
  assert.ok(args.includes("--unshare-pid"));
  // ADR-0081 §3: the completed hardening flag set.
  assert.ok(args.includes("--unshare-ipc"));
  assert.ok(args.includes("--unshare-uts"));
  assert.ok(args.includes("--unshare-cgroup"));
  assert.ok(args.includes("--new-session"));
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(args.includes("--die-with-parent"));
  assert.ok(args.includes("--share-net"));
  assert.deepEqual(args.slice(-4), ["--", "bash", "-lc", "npm test"]);
});

test("ADR-0079: buildBwrapArgs rejects cwd escaping the workspace", () => {
  assert.throws(
    () => buildBwrapArgs({ workspace: "/tmp/ws/a", cwd: "/tmp/ws/b", command: "ls", exists: () => false }),
    /escapes workspace/,
  );
});

test("ADR-0081: binds only the worktree gitdir, the object store and the worktree's own branch ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-bwrap-wt-"));
  try {
    const gitdir = join(dir, "main-git", "worktrees", "item-1");
    const common = join(dir, "main-git");
    const ws = join(dir, "ws");
    mkdirSync(join(common, "objects"), { recursive: true });
    mkdirSync(join(common, "refs", "heads", "factory"), { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/factory/item-1\n");
    writeFileSync(join(common, "refs", "heads", "factory", "item-1"), `${"0".repeat(40)}\n`);
    writeFileSync(join(common, "refs", "heads", "master"), `${"1".repeat(40)}\n`);
    writeFileSync(join(common, "config"), "[core]\n");
    writeFileSync(join(ws, ".git"), `gitdir: ${gitdir}\n`);

    const args = buildBwrapArgs({ workspace: ws, cwd: ws, command: "git status", exists: () => true });
    const roBinds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--ro-bind") roBinds.push(args[i + 1]);
    assert.ok(roBinds.includes(gitdir), "worktree gitdir is bound");
    assert.ok(roBinds.includes(join(common, "objects")), "object store is bound");
    assert.ok(roBinds.includes(join(common, "refs", "heads", "factory", "item-1")), "own branch ref is bound");
    assert.ok(!roBinds.includes(common), "the common dir is not bound wholesale");
    assert.ok(!roBinds.includes(join(common, "refs")), "refs are not exposed as a directory");
    assert.ok(!roBinds.includes(join(common, "refs", "heads", "master")), "another branch is not bound");
    assert.ok(!roBinds.includes(join(common, "config")), "the checkout config is not bound");
    assert.ok(roBinds.includes(join(ws, ".git")), ".git pointer file is overlaid read-only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-0079: buildBwrapArgs overlays a real .git directory read-only after the workspace bind", () => {
  const ws = "/tmp/fake-baseline/repo";
  const dotGit = join(ws, ".git");
  const args = buildBwrapArgs({ workspace: ws, cwd: ws, command: "true", exists: (p) => p === dotGit });
  const rwIdx = args.indexOf("--bind");
  const roIdx = args.lastIndexOf("--ro-bind");
  assert.ok(roIdx > rwIdx);
  assert.equal(args[roIdx + 1], dotGit);
  assert.equal(args[roIdx + 2], dotGit);
});

test("ADR-0079: BwrapEnvironment implements ShellConfiner & IsolatedSnapshotEnvironment and safely quotes shell commands", () => {
  const env = new BwrapEnvironment();
  assert.equal(canConfineShell(env), true);
  assert.equal(canPrepareIsolated(env), true);
  assert.equal(env.isolatesCandidate, true);

  const confined = env.confineShell({
    workspace: "/tmp/ws",
    cwd: "/tmp/ws",
    command: "echo 'hello world' && pwd",
    env: { PATH: "/usr/bin", HOME: "/home/secret-user" },
  });
  assert.equal(confined.env.HOME, "/tmp/home");
  assert.match(confined.command, /^exec bwrap /);
  assert.ok(confined.command.includes(shellQuote("echo 'hello world' && pwd")));
});

test("ADR-0079: BwrapEnvironment.health reports process isolation and executes isolated commands when bwrap is installed", async (t) => {
  const env = new BwrapEnvironment();
  const health = await env.health();
  assert.equal(health.runtime, "bwrap");
  assert.equal(health.isolation, "process");
  if (!health.available) {
    t.skip(`bwrap unavailable on this host: ${health.message}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "factory-bwrap-live-"));
  try {
    const ws = join(dir, "repo");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "README.md"), "hello\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.email=f@f", "-c", "user.name=f", "commit", "-qm", "init");
    const baseCommit = git("rev-parse", "HEAD");

    const spec: SandboxSpec = {
      profile: { apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "SandboxProfile", metadata: { name: "node-build" }, spec: { image: "", isolation: "process" } },
      repositories: [],
      workspaces: [{
        apiVersion: "factory.ai-dlc.io/v1alpha1",
        kind: "Workspace",
        metadata: { name: "item-repo" },
        spec: { repositoryRef: { name: "repo" }, workItemRef: { name: "item" }, branch: "factory/item" },
        status: { phase: "Ready", path: ws, baseCommit },
      }],
    };
    const sb = await env.prepare(spec);
    const res = await sb.exec("echo home=$HOME && cat README.md && ls -la /home 2>&1 || true");
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /home=\/tmp\/home/);
    assert.match(res.stdout, /hello/);
    assert.doesNotMatch(res.stdout, /\.ssh/);
    await sb.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-0081 §4: a confined command keeps its own branch but cannot read another branch, the checkout config, $HOME or a symlink escape", async (t) => {
  const env = new BwrapEnvironment();
  const health = await env.health();
  if (!health.available) {
    t.skip(`bwrap unavailable on this host: ${health.message}`);
    return;
  }
  assert.match(health.message ?? "", /command execution/, "the health claim names the confined scope (ADR-0081 §1)");

  const dir = mkdtempSync(join(tmpdir(), "factory-bwrap-escape-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: src, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
    git("init", "-q");
    writeFileSync(join(src, "a.txt"), "one\n");
    git("add", ".");
    git("-c", "user.email=f@f", "-c", "user.name=f", "commit", "-qm", "init");
    git("branch", "other");
    const baseCommit = git("rev-parse", "HEAD");
    const ws = join(dir, "ws");
    git("worktree", "add", "-q", "-b", "factory/item-1", ws, "HEAD");

    // A file outside the workspace and a symlink inside it pointing at that file.
    const outside = join(dir, "outside-secret.txt");
    writeFileSync(outside, "top secret\n");
    symlinkSync(outside, join(ws, "evil"));

    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ws }).toString().trim();
    const spec: SandboxSpec = {
      profile: { apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "SandboxProfile", metadata: { name: "node-build" }, spec: { image: "", isolation: "process" } },
      repositories: [],
      workspaces: [{
        apiVersion: "factory.ai-dlc.io/v1alpha1",
        kind: "Workspace",
        metadata: { name: "item-repo" },
        spec: { repositoryRef: { name: "repo" }, workItemRef: { name: "item" }, branch: "factory/item-1" },
        status: { phase: "Ready", path: ws, baseCommit },
      }],
    };
    const sb = await env.prepare(spec);
    try {
      // Own branch: ordinary git keeps working (bare `git log`/`git status` resolve the bound own ref).
      const ok = await sb.exec("git status --porcelain && git log --oneline -1");
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.match(ok.stdout, /init/);

      const hostHome = process.env.HOME ?? "/root";
      for (const path of [join(common, "refs", "heads", "other"), join(common, "config"), join(ws, "evil"), join(hostHome, ".bashrc")]) {
        const r = await sb.exec(`cat ${JSON.stringify(path)}`);
        assert.notEqual(r.exitCode, 0, `expected ${path} to be unreadable inside the sandbox`);
      }
    } finally {
      await sb.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** ADR-0088: declared tools are read-only for every command; only provisioning writes, and HOME is per workspace. */
test("ADR-0088: buildBwrapArgs mounts the toolchain cache read-only unless it provisions, with a per-workspace HOME", () => {
  const workspace = "/tmp/fake-workspaces/item-1/repo";
  const toolchainDir = "/tmp/fake-toolchain";
  const homeDir = sandboxHome(toolchainDir, workspace);
  const mounts = (args: string[]) => args.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [[a, args[i + 1], args[i + 2]]] : []));

  // A command sandbox: the cache is read-only and HOME is the item's own writable directory.
  const command = buildBwrapArgs({ workspace, cwd: workspace, command: "make test", toolchainDir, homeDir });
  assert.deepEqual(mounts(command).filter(([, , to]) => to === TOOLCHAIN_MOUNT), [["--ro-bind", toolchainDir, TOOLCHAIN_MOUNT]]);
  assert.deepEqual(mounts(command).filter(([, , to]) => to === "/tmp/home"), [["--bind", homeDir, "/tmp/home"]]);

  // An isolated snapshot: read-only cache and an ephemeral HOME, so nothing the candidate writes can reach evidence.
  const isolated = buildBwrapArgs({ workspace, cwd: workspace, command: "make test", toolchainDir });
  assert.deepEqual(mounts(isolated).filter(([, , to]) => to === TOOLCHAIN_MOUNT), [["--ro-bind", toolchainDir, TOOLCHAIN_MOUNT]]);
  const tmpfs = isolated.flatMap((a, i) => (a === "--tmpfs" ? [isolated[i + 1]] : []));
  assert.ok(tmpfs.includes("/tmp/home"), "an isolated snapshot gets an ephemeral HOME");
  assert.ok(!mounts(isolated).some(([, , to]) => to === "/tmp/home"), "and no writable HOME is bound into it");

  // Only the provisioning sandbox may write the cache — and it runs with an ephemeral HOME, so a candidate that wrote
  // `~/.config/go/env` or `.netrc` cannot steer what lands in a cache every item shares.
  const provisioning = buildBwrapArgs({ workspace, cwd: workspace, command: "go install x@v1", toolchainDir, writableToolchain: true });
  assert.deepEqual(mounts(provisioning).filter(([, , to]) => to === TOOLCHAIN_MOUNT), [["--bind", toolchainDir, TOOLCHAIN_MOUNT]]);
  assert.ok(!mounts(provisioning).some(([, , to]) => to === "/tmp/home"), "provisioning must not see a writable per-workspace HOME");

  // The same workspace always maps to the same home; another workspace does not share it, and the homes live OUTSIDE
  // the mounted cache so a sandbox cannot read another item's home through the read-only toolchain mount.
  assert.equal(sandboxHome(toolchainDir, workspace), homeDir);
  assert.notEqual(sandboxHome(toolchainDir, "/tmp/fake-workspaces/item-2/repo"), homeDir);
  assert.ok(!sandboxHome(toolchainDir, workspace).startsWith(`${toolchainDir}/`), "homes are not inside the mounted cache");
});

/** ADR-0088: tools are read-only on PATH; the caches they fill are data and live in the writable HOME. */
test("ADR-0088: sandboxEnv puts the cache first on PATH and the caches in HOME", () => {
  const toolchainDir = "/tmp/fake-toolchain";
  const env = sandboxEnv({ GOPROXY: "https://proxy.golang.org" }, toolchainDir);
  assert.match(String(env.PATH), /^\/factory-tools\/bin:/);
  assert.equal(env.GOBIN, `${TOOLCHAIN_MOUNT}/bin`);
  assert.equal(env.GOPATH, "/tmp/home/go", "the module cache must be writable");
  assert.equal(env.npm_config_cache, "/tmp/home/npm");
  assert.equal(env.HOME, "/tmp/home", "HOME is never the operator's");
  assert.equal(env.GOPROXY, "https://proxy.golang.org", "profile values still apply");

  assert.equal(sandboxEnv({}, undefined).GOBIN, undefined, "without a cache there is no cache environment");
  assert.equal(sandboxEnv({ PATH: "/custom" }, undefined).PATH, "/custom", "a profile PATH is untouched without a cache");
  assert.equal(sandboxEnv({ PATH: "/custom" }, toolchainDir).PATH, `${TOOLCHAIN_MOUNT}/bin:/custom`, "the cache is prepended to a profile PATH");
});

/** ADR-0088 §5: an environment that cannot provide a declared tool fails visibly as Unavailable, naming the tool. */
test("ADR-0088: prepare() fails as Unavailable when a declared tool cannot be provided", async () => {
  const ws = { apiVersion: "v", kind: "Workspace", metadata: { name: "item-repo", namespace: "default" },
    spec: { workItemRef: { name: "item" }, repositoryRef: { name: "repo" }, branch: "b" },
    status: { phase: "Ready", path: "/tmp/fake-workspaces/item-1/repo", baseCommit: "a".repeat(40) } };
  const profile = { apiVersion: "v", kind: "SandboxProfile", metadata: { name: "p", namespace: "factory-system" },
    spec: { image: "x", tools: [{ name: "gotestsum", provides: "bin/gotestsum", via: { type: "goInstall" } }] } };
  const failing = {
    async status() { return []; },
    async ensure() { return [{ name: "gotestsum", type: "goInstall", state: "failed", message: "lookup proxy.golang.org: connection refused" }]; },
  };
  const environment = new BwrapEnvironment({ toolchainDir: "/tmp/fake-toolchain", toolchain: failing as never });

  await assert.rejects(environment.prepare({ profile, repositories: [], workspaces: [ws] } as never),
    /could not provide gotestsum \(goInstall\): lookup proxy\.golang\.org: connection refused/);
});

/** ADR-0088: the cache is bound into the sandbox, so it must exist before the first command. */
test("ADR-0088: the environment creates its toolchain cache directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sf-cache-")), "toolchain");
  assert.ok(!existsSync(dir));
  new BwrapEnvironment({ toolchainDir: dir });
  assert.ok(existsSync(dir), "binding a missing directory would fail every command");
});

/** ADR-0092: the publication commit is made inside bwrap, over a throwaway overlay of the workspace, into a private git directory. */
test("ADR-0092: commitCandidate commits in bwrap without writing the workspace or the shared clone; a hook that changes files is rejected and its writes vanish", async (t) => {
  const hooked: CommitHookSetup = {
    type: "rewrite",
    // A "formatter" that rewrites a file and writes a cache: the change rejects the commit, and neither write survives.
    install: `mkdir -p "$GIT_DIR/hooks" && printf '#!/bin/bash\\nmkdir -p "$GIT_WORK_TREE/.cache" && echo reformatted > "$GIT_WORK_TREE/a.txt"\\n' > "$GIT_DIR/hooks/pre-commit" && chmod +x "$GIT_DIR/hooks/pre-commit"`,
  };
  const forge: CommitHookSetup = {
    type: "forge",
    install: `mkdir -p "$GIT_DIR/hooks" && printf '#!/bin/bash\nfor f in "$OUT"/../commit/candidate.bundle "$OUT"/../*/candidate.bundle; do echo forged > "$f" 2>/dev/null; done; exit 0\n' > "$GIT_DIR/hooks/pre-commit" && chmod +x "$GIT_DIR/hooks/pre-commit"`,
  };
  const setups: Record<string, CommitHookSetup> = { rewrite: hooked, forge };
  const env = new BwrapEnvironment({ commitHooks: { get: (k) => setups[k], keys: () => Object.keys(setups) } });
  const health = await env.health();
  if (!health.available) {
    t.skip(`bwrap unavailable on this host: ${health.message}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "factory-bwrap-commit-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
    git(src, "init", "-q");
    writeFileSync(join(src, "a.txt"), "one\n");
    git(src, "add", ".");
    git(src, "-c", "user.email=f@f", "-c", "user.name=f", "commit", "-qm", "init");
    const baseCommit = git(src, "rev-parse", "HEAD");
    const ws = join(dir, "ws");
    git(src, "worktree", "add", "-q", "-b", "factory/item-1", ws, "HEAD");
    writeFileSync(join(ws, "a.txt"), "two\n");
    writeFileSync(join(ws, "new.txt"), "new\n");
    const spec: SandboxSpec = {
      profile: { apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "SandboxProfile", metadata: { name: "p" }, spec: { image: "", isolation: "process" } },
      repositories: [],
      workspaces: [{ apiVersion: "factory.ai-dlc.io/v1alpha1", kind: "Workspace", metadata: { name: "item-repo" },
        spec: { repositoryRef: { name: "repo" }, workItemRef: { name: "item" }, branch: "factory/item-1" },
        status: { phase: "Ready", path: ws, baseCommit } }],
    };
    const outDir = mkdtempSync(join(tmpdir(), "factory-bwrap-commit-out-"));
    const made = await env.commitCandidate(spec, { branch: "factory/item-1", message: "feat: change a\n\nWork item: item", outDir });
    assert.match(made.commit, /^[a-f0-9]{40}$/);
    const bundled = git(src, "bundle", "list-heads", made.bundlePath);
    assert.match(bundled, new RegExp(`^${made.commit} refs/heads/factory/item-1$`));
    assert.equal(git(ws, "rev-parse", "HEAD"), baseCommit, "the workspace branch did not move");
    assert.throws(() => git(src, "cat-file", "-e", made.commit), "the shared object store never received the commit");
    rmSync(outDir, { recursive: true, force: true });

    const out2 = mkdtempSync(join(tmpdir(), "factory-bwrap-commit-out-"));
    await assert.rejects(env.commitCandidate(spec, { branch: "factory/item-1", message: "m", outDir: out2, hooks: "rewrite" }),
      (e: unknown) => e instanceof CandidateCommitRejectedError && /changed the candidate/.test(e.message));
    assert.equal(execFileSync("cat", [join(ws, "a.txt")]).toString(), "two\n", "the hook could not change the workspace");
    assert.ok(!existsSync(join(ws, ".cache")), "the hook's writes went to the throwaway overlay");
    rmSync(out2, { recursive: true, force: true });

    // A hook that passes but tries to replace the published bundle: it runs separately and cannot reach the commit run's
    // directory, so what is published is still the factory-made commit (the reviewer's forgery scenario).
    const out3 = mkdtempSync(join(tmpdir(), "factory-bwrap-commit-out-"));
    const honest = await env.commitCandidate(spec, { branch: "factory/item-1", message: "m", outDir: mkdtempSync(join(tmpdir(), "factory-bwrap-commit-ref-")) });
    const forging = await env.commitCandidate(spec, { branch: "factory/item-1", message: "m", outDir: out3, hooks: "forge" });
    assert.equal(forging.tree, honest.tree, "the published tree is the candidate's");
    assert.equal(git(src, "bundle", "list-heads", forging.bundlePath).split(" ")[0], forging.commit, "the bundle is the commit run's, not the hook's");
    rmSync(out3, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

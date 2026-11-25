import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CandidateCommitRejectedError, type CandidateCommit, type CandidateCommitInput, type CommitHookSetup, type ExecResult } from "../../ports/index.ts";

/** Identity of factory-made commits (same as `FACTORY_GIT_IDENTITY`). */
const IDENTITY = { name: "Software Factory", email: "software-factory@users.noreply.github.com" };

/**
 * ADR-0092: the commit job. Runs with the workspace as cwd (a throwaway overlay in `bwrap`) and `$OUT` writable; reads
 * the workspace's HEAD (and `MERGE_HEAD` of an ADR-0053 base merge), commits the working copy in a **private** git
 * directory under `$OUT` whose objects borrow the workspace's through `alternates`, and bundles `refs/heads/$BRANCH`.
 * Nothing is written to the shared repository. The last stdout line is `RESULT <commit> <tree>`.
 *
 * With `HOOK_INSTALL` set it is the **hook run**: it installs the repository's hooks, commits with verification against
 * `EXPECTED_TREE`, and writes no bundle. Its outcome is pass/fail only; the published commit always comes from a run
 * without hooks, so no hook can influence what is pushed.
 */
export const COMMIT_JOB_SCRIPT = `set -euo pipefail
g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
head=$(g -C "$WS" rev-parse --verify HEAD)
objects=$(cd "$WS" && g rev-parse --path-format=absolute --git-path objects)
merge=$(g -C "$WS" rev-parse -q --verify MERGE_HEAD || true)
git init -q --bare "$OUT/git"
export GIT_DIR="$OUT/git" GIT_WORK_TREE="$WS"
git config core.bare false
echo "$objects" > "$GIT_DIR/objects/info/alternates"
git update-ref "refs/heads/$BRANCH" "$head"
git symbolic-ref HEAD "refs/heads/$BRANCH"
git read-tree HEAD
if [ -n "$merge" ]; then echo "$merge" > "$GIT_DIR/MERGE_HEAD"; fi
git add -A
tree=$(git write-tree)
if [ -n "\${EXPECTED_TREE:-}" ] && [ "$tree" != "$EXPECTED_TREE" ]; then
  echo "the candidate changed during publication" >&2
  exit 5
fi
if [ -n "$merge" ] || [ "$tree" != "$(git rev-parse 'HEAD^{tree}')" ]; then
  id=(-c "user.name=$COMMIT_NAME" -c "user.email=$COMMIT_EMAIL")
  if [ -n "\${HOOK_INSTALL:-}" ]; then
    bash -c "$HOOK_INSTALL"
    git "\${id[@]}" commit -q --no-edit -F "$OUT/message"
    # Neither the commit nor the working copy may differ from what was staged: hooks may check, never change.
    git add -A
    if [ "$(git rev-parse 'HEAD^{tree}')" != "$tree" ] || [ "$(git write-tree)" != "$tree" ]; then
      echo "a commit hook changed the candidate; hooks may check, never change it (ADR-0092)" >&2
      exit 3
    fi
  else
    git "\${id[@]}" -c core.hooksPath=/dev/null commit -q --no-verify --no-edit -F "$OUT/message"
  fi
fi
if [ -n "\${HOOK_INSTALL:-}" ]; then echo "HOOKS PASSED"; exit 0; fi
git bundle create -q "$OUT/candidate.bundle" "refs/heads/$BRANCH"
echo "RESULT $(git rev-parse HEAD) $tree"
`;

/** ADR-0092: the pre-commit framework, honouring the candidate's `default_install_hook_types`. */
export const PRE_COMMIT_HOOKS: CommitHookSetup = {
  type: "pre-commit",
  install: [
    `command -v pre-commit >/dev/null || { echo "pre-commit is not installed in the sandbox (ADR-0092)" >&2; exit 4; }`,
    "pre-commit install --install-hooks >/dev/null",
  ].join("\n"),
};

/** One run of the commit job: its private directory (bound writable), script and environment. */
export interface CommitJob {
  dir: string;
  script: string;
  env: Record<string, string>;
}

/** Writes a job's inputs into `<outDir>/<name>` (the only directory that run may write). */
export async function prepareCommitJob(workspace: string, input: CandidateCommitInput, name: "commit" | "hooks",
  extra: { hooks?: CommitHookSetup; expectedTree?: string } = {}): Promise<CommitJob> {
  const dir = join(input.outDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, "commit.sh");
  await writeFile(script, COMMIT_JOB_SCRIPT, { mode: 0o600 });
  await writeFile(join(dir, "message"), input.message.endsWith("\n") ? input.message : `${input.message}\n`, { mode: 0o600 });
  const env: Record<string, string> = {
    WS: workspace, OUT: dir, BRANCH: input.branch, COMMIT_NAME: IDENTITY.name, COMMIT_EMAIL: IDENTITY.email,
    ...(extra.hooks ? { HOOK_INSTALL: extra.hooks.install } : {}),
    ...(extra.expectedTree ? { EXPECTED_TREE: extra.expectedTree } : {}),
  };
  return { dir, script, env };
}

const MAX_REPORTED_OUTPUT = 4000;
const rejected = (reason: string, output: string) =>
  new CandidateCommitRejectedError(`publication commit rejected: ${reason}${output ? `\n${output.slice(-MAX_REPORTED_OUTPUT)}` : ""}`, output);

function failure(result: ExecResult): string {
  return result.exitCode === 3 ? "a commit hook changed the candidate"
    : result.exitCode === 4 ? "the commit hook tool is not available in the sandbox"
    : result.exitCode === 5 ? "the candidate changed during publication"
    : result.termination?.kind === "timeout" ? "the commit job timed out" : `the commit job failed (exit ${result.exitCode})`;
}

/**
 * ADR-0092: runs the publication commit. The **commit run** (factory-authored script, no hooks; `bwrap`: no network)
 * produces the bundle that is published. With hooks, a separate **hook run** then checks the same tree and message; it
 * can only pass or fail publication and never writes into the commit run's directory.
 */
export async function runCommitJobs(workspace: string, input: CandidateCommitInput, hooks: CommitHookSetup | undefined,
  run: (job: CommitJob, withHooks: boolean) => Promise<ExecResult>): Promise<CandidateCommit> {
  const commitJob = await prepareCommitJob(workspace, input, "commit");
  const result = await run(commitJob, false);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.exitCode !== 0) throw rejected(failure(result), output);
  const match = /^RESULT ([a-f0-9]{40,64}) ([a-f0-9]{40,64})$/m.exec(result.stdout);
  if (!match) throw rejected("the commit job reported no result", output);
  const bundlePath = join(commitJob.dir, "candidate.bundle");
  await readFile(bundlePath).catch(() => { throw rejected("no bundle was written", output); });
  const made: CandidateCommit = { bundlePath, ref: `refs/heads/${input.branch}`, commit: match[1], tree: match[2] };
  if (!hooks) return made;

  const hookJob = await prepareCommitJob(workspace, input, "hooks", { hooks, expectedTree: made.tree });
  const checked = await run(hookJob, true);
  const hookOutput = `${checked.stdout}${checked.stderr}`.trim();
  if (checked.exitCode !== 0) throw rejected(`the repository's commit hooks failed: ${failure(checked)}`, hookOutput);
  if (!/^HOOKS PASSED$/m.test(checked.stdout)) throw rejected("the hook run reported no result", hookOutput);
  return made;
}

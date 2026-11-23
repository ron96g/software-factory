import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import {
  DEFAULT_EXPORT_LIMITS,
  ExportRejectedError,
  type CandidateExport,
  type CandidateDiffer,
  type ExportIngestInput,
  type ExportIngestor,
  type ExportLimits,
} from "../../ports/index.ts";
import { GIT_HARDENING, gitLocalEnv } from "./git-auth.ts";

const execFileP = promisify(execFile);
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * ADR-0080 §13: ingests an untrusted git bundle into a factory-owned **bare** mirror. `git fsck --strict` validates the
 * objects; explicit size, object and ref limits are enforced; submodules are refused; symlinks are recorded, never
 * followed; and nothing is ever checked out or run (no config, hooks or filters from the incoming objects apply).
 */
export class GitBundleIngest implements ExportIngestor {
  private readonly limits: ExportLimits;
  constructor(limits: Partial<ExportLimits> = {}) {
    this.limits = { ...DEFAULT_EXPORT_LIMITS, ...limits };
  }

  async ingest(input: ExportIngestInput): Promise<CandidateExport> {
    const limits = { ...this.limits, ...input.limits };
    const bytes = statSync(input.bundlePath).size;
    if (bytes > limits.maxBytes) throw new ExportRejectedError("too-large", `export bundle is ${bytes} bytes, limit ${limits.maxBytes}`);

    if (!existsSync(input.mirrorPath)) await mkdir(input.mirrorPath, { recursive: true });
    const git = async (...args: string[]) =>
      (await execFileP("git", [...GIT_HARDENING, ...args], { cwd: input.mirrorPath, env: gitLocalEnv(), maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
    const isBare = async () => (await git("rev-parse", "--is-bare-repository").catch(() => "")).trim() === "true";

    // A factory-owned bare mirror: no working tree, so nothing is ever checked out.
    if (!(await isBare())) {
      await git("init", "--bare", "--quiet").catch(() => {});
      if (!(await isBare())) throw new ExportRejectedError("no-mirror", "the export mirror is not a bare git repository");
    }

    const heads = lines(await git("bundle", "list-heads", input.bundlePath).catch((e) => {
      throw new ExportRejectedError("bad-bundle", `not a git bundle: ${e instanceof Error ? e.message : String(e)}`);
    }));
    if (!heads.length) throw new ExportRejectedError("empty-bundle", "the export bundle carries no refs");
    const wanted = input.ref ? heads.find((l) => l.endsWith(` ${input.ref}`)) : heads[0];
    if (!wanted) throw new ExportRejectedError("no-ref", `the export bundle does not carry ref "${input.ref}"`);
    const exportedRef = wanted.split(/\s+/)[1];
    const intoRef = input.intoRef ?? "refs/factory/export/candidate";

    // Fetching applies no incoming config, hooks or filters (GIT_HARDENING + a scrubbed env) and never touches a worktree.
    await git("fetch", "--no-tags", "--quiet", "--", input.bundlePath, `${exportedRef}:${intoRef}`).catch((e) => {
      throw new ExportRejectedError("unfetchable", `could not ingest the bundle (is it self-contained?): ${e instanceof Error ? e.message : String(e)}`);
    });

    await git("fsck", "--strict", "--no-progress").catch((e) => {
      throw new ExportRejectedError("invalid-objects", `fsck rejected the exported objects: ${e instanceof Error ? e.message : String(e)}`);
    });
    const commit = await git("rev-parse", "--verify", `${intoRef}^{commit}`).catch(() => {
      throw new ExportRejectedError("no-commit", "the exported ref is not a commit");
    });

    const refs = lines(await git("show-ref")).length;
    if (refs > limits.maxRefs) throw new ExportRejectedError("too-many-refs", `the mirror holds ${refs} refs, limit ${limits.maxRefs}`);
    const counts = await git("count-objects", "-v");
    const num = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(counts)?.[1] ?? "0");
    const objects = num("count") + num("in-pack");
    if (objects > limits.maxObjects) throw new ExportRejectedError("too-many-objects", `the export carries ${objects} objects, limit ${limits.maxObjects}`);

    // Submodules (gitlinks) are refused; symlinks (mode 120000) are recorded as blobs, never followed.
    if (/(^|\n)160000 /.test(await git("ls-tree", "-r", commit))) {
      throw new ExportRejectedError("submodules", "the exported commit contains a submodule (gitlink), which the factory refuses");
    }

    return { commit, ref: intoRef, exportedRef, objects, refs, bytes };
  }
}

/**
 * ADR-0080 §13: the diff of an ingested candidate against its seed commit, read from the factory-owned **bare** mirror
 * through plumbing only — no checkout, no working tree, no incoming config/hooks applied.
 */
export class GitCandidateDiffer implements CandidateDiffer {
  async diff(input: { mirrorPath: string; base: string; candidate: string }): Promise<string> {
    const { stdout } = await execFileP("git", [...GIT_HARDENING, "diff", "--no-color", input.base, input.candidate], {
      cwd: input.mirrorPath,
      env: gitLocalEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
}

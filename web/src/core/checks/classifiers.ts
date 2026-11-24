import type { CheckOutcome } from "../model/kinds.ts";
import type { CheckFinding } from "../model/kinds.ts";
import type { CheckResultClassifier, FindingExtractor, TestResultExtractor } from "../ports/verification.ts";
import { TEST_PATH_SEPARATOR } from "../model/tests.ts";
import type { ExecResult } from "../ports/sandbox.ts";
import type { Registrar } from "../ports/integration.ts";

function terminationOutcome(result: ExecResult): CheckOutcome | undefined {
  switch (result.termination?.kind) {
    case "timeout": return "TimedOut";
    case "signal": return "Cancelled";
    case "spawn-error": return "Unavailable";
    default: return undefined;
  }
}

export const exitCodeClassifier: CheckResultClassifier = {
  format: "exit-code",
  classify(result) {
    const terminated = terminationOutcome(result);
    if (terminated) return terminated;
    if (result.exitCode === 0) return "Passed";
    return "UnknownFailure";
  },
};

interface GoTestEvent {
  Action?: unknown;
  Package?: unknown;
  Test?: unknown;
}

const goActions = new Set(["start", "run", "pause", "cont", "pass", "bench", "fail", "skip", "output"]);
const testKey = (event: GoTestEvent) => `${event.Package}\0${event.Test}`;

function exactTests(names: string[]): { tests: string[] } | undefined {
  const tests = [...new Set(names.map((name) => name.trim()))].sort();
  return tests.length && tests.length <= 50 && tests.every((name) => name.length > 0 && name.length <= 256 && !/[\x00-\x1f\x7f]/.test(name))
    ? { tests } : undefined;
}

export const goTestJsonClassifier: CheckResultClassifier = {
  format: "go-test-json",
  classify(result) {
    const terminated = terminationOutcome(result);
    if (terminated) return terminated;
    if (result.truncated) return "NotVerified";

    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) return "NotVerified";
    const events: GoTestEvent[] = [];
    try {
      for (const line of lines) {
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== "object" || Array.isArray(event)) return "NotVerified";
        const record = event as GoTestEvent;
        if (typeof record.Action !== "string" || !goActions.has(record.Action)) return "NotVerified";
        if (record.Package !== undefined && typeof record.Package !== "string") return "NotVerified";
        if (record.Test !== undefined && typeof record.Test !== "string") return "NotVerified";
        events.push(record);
      }
    } catch {
      return "NotVerified";
    }

    const started = new Set(events
      .filter((event) => event.Action === "run" && event.Test && event.Package)
      .map(testKey));
    const failedTests = events.filter((event) =>
      event.Action === "fail" && event.Test && event.Package && started.has(testKey(event)));
    if (result.exitCode !== 0 && failedTests.length > 0) return "AssertionFailed";

    const passedTests = events.filter((event) =>
      event.Action === "pass" && event.Test && event.Package && started.has(testKey(event)));
    if (result.exitCode === 0 && passedTests.length > 0 && failedTests.length === 0) return "Passed";

    const packageFailure = events.some((event) => event.Action === "fail" && !event.Test);
    if (packageFailure || result.exitCode !== 0) return "UnknownFailure";
    return "NotVerified";
  },
  failureEvidence(result) {
    if (this.classify(result) !== "AssertionFailed") return undefined;
    const events: GoTestEvent[] = result.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const started = new Set(events.filter((event) => event.Action === "run" && event.Test && event.Package).map(testKey));
    return exactTests(events.filter((event) => event.Action === "fail" && event.Test && event.Package && started.has(testKey(event)))
      .map((event) => `${event.Package}::${event.Test}`));
  },
};

interface TapTest { name: string; ok: boolean; skipped: boolean; leaf: boolean; diagnostics: Record<string, string> }

/**
 * Node's TAP reporter: tests nest by 4-space indentation, a `# Subtest:` line opens each one and its `ok`/`not ok` line
 * closes it, followed by a YAML-ish diagnostics block. Returns every test with its full name path.
 */
function parseTap(stdout: string): TapTest[] {
  const lines = stdout.split(/\r?\n/);
  const path: string[] = [];
  const children: boolean[] = [];
  const tests: TapTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const subtest = /^( *)# Subtest: (.*)$/.exec(line);
    if (subtest) {
      const level = subtest[1].length / 4;
      path.length = level;
      path[level] = subtest[2];
      children[level] = false;
      continue;
    }
    const result = /^( *)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!result) continue;
    const indent = result[1].length;
    const level = indent / 4;
    if (level > 0) children[level - 1] = true;
    const diagnostics: Record<string, string> = {};
    if (lines[i + 1] === `${result[1]}  ---`) {
      for (i += 2; i < lines.length && lines[i] !== `${result[1]}  ...`; i++) {
        const field = new RegExp(`^ {${indent + 2}}([A-Za-z]+): (.*)$`).exec(lines[i]);
        if (field) diagnostics[field[1]] = field[2].replace(/^'(.*)'$/, "$1");
      }
    }
    const names = [...path.slice(0, level), result[3]];
    tests.push({ name: names.join(TEST_PATH_SEPARATOR), ok: result[2] === "ok", skipped: result[4] === "SKIP", leaf: !children[level], diagnostics });
    children[level] = false;
  }
  return tests;
}

/** A named failure raised by test code: not a hook, a cancellation, a crashed file (it carries `exitCode`) or a parent. */
const namedFailure = (t: TapTest) => !t.ok && t.leaf && t.diagnostics.failureType === "testCodeFailure" && t.diagnostics.exitCode === undefined;

/** ADR-0086: Node's TAP output, classified by test: any failure raised by test code is a named test failure. */
export const nodeTestTapClassifier: CheckResultClassifier & TestResultExtractor = {
  format: "node-test-tap",
  classify(result) {
    const terminated = terminationOutcome(result);
    if (terminated) return terminated;
    if (result.truncated || !/^TAP version 13\r?$/m.test(result.stdout)) return "NotVerified";
    const count = (name: string) => {
      const matches = [...result.stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
      return matches.length === 1 ? Number(matches[0][1]) : undefined;
    };
    const tests = count("tests"), passed = count("pass"), failed = count("fail"), cancelled = count("cancelled");
    if (tests === undefined || passed === undefined || failed === undefined || cancelled === undefined ||
        !/^1\.\.\d+\r?$/m.test(result.stdout) || tests < 1 || passed + failed > tests) return "NotVerified";
    if (result.exitCode === 0) return failed === 0 && cancelled === 0 && passed > 0 ? "Passed" : "NotVerified";
    if (!failed || cancelled) return "UnknownFailure";
    const reported = parseTap(result.stdout);
    // A parent fails because a subtest failed; every other failure must be a named one.
    const failures = reported.filter((t) => !t.ok && !(!t.leaf && t.diagnostics.failureType === "subtestsFailed"));
    if (!failures.length || !failures.every(namedFailure)) return "UnknownFailure";
    return "AssertionFailed";
  },
  failureEvidence(result) {
    if (this.classify(result) !== "AssertionFailed") return undefined;
    return exactTests(parseTap(result.stdout).filter(namedFailure).map((t) => t.name));
  },
  testResults(result) {
    const outcome = this.classify(result);
    if (outcome !== "Passed" && outcome !== "AssertionFailed") return undefined;
    const leaves = parseTap(result.stdout).filter((t) => t.leaf);
    return {
      failed: leaves.filter(namedFailure).map((t) => ({ name: t.name, file: t.diagnostics.location?.replace(/:\d+:\d+$/, "") })),
      passed: leaves.filter((t) => t.ok && !t.skipped).map((t) => t.name),
      skipped: leaves.filter((t) => t.skipped).length,
    };
  },
};

interface AuditVia { name?: string; severity?: string; title?: string; source?: unknown; url?: string }
interface AuditVulnerability { name?: string; severity?: string; via?: (string | AuditVia)[]; nodes?: string[]; range?: string }

function parseAudit(result: ExecResult): { findings: CheckFinding[]; error: boolean } | undefined {
  if (result.truncated) return undefined;
  let doc: { vulnerabilities?: Record<string, AuditVulnerability>; error?: unknown; metadata?: unknown };
  try { doc = JSON.parse(result.stdout); } catch { return { findings: [], error: true }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { findings: [], error: true };
  if (doc.error) return { findings: [], error: true };
  if (!doc.vulnerabilities || typeof doc.vulnerabilities !== "object") return { findings: [], error: true };
  const findings: CheckFinding[] = [];
  for (const [pkg, vuln] of Object.entries(doc.vulnerabilities)) {
    const nodes = vuln.nodes?.length ? [...vuln.nodes].sort() : [""];
    const advisories = (vuln.via ?? []).filter((v): v is AuditVia => typeof v === "object" && v !== null);
    const ids = advisories.length ? advisories : [{ source: "transitive", severity: vuln.severity }];
    for (const adv of ids) for (const node of nodes) {
      const severity = adv.severity ?? vuln.severity ?? "unknown";
      findings.push({ id: [String(adv.source ?? adv.url ?? adv.title ?? ""), vuln.name ?? pkg, vuln.range ?? "", node, severity].join("|"), severity, title: adv.title });
    }
  }
  const seen = new Map(findings.map((f) => [f.id, f]));
  return { findings: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)), error: false };
}

/** ADR-0067: `npm audit --json`. Finding identity is advisory + package + version range + dependency path + severity. */
export const npmAuditJsonClassifier: CheckResultClassifier & FindingExtractor = {
  format: "npm-audit-json",
  classify(result) {
    const terminated = terminationOutcome(result);
    if (terminated) return terminated;
    if (result.exitCode === 0) return "Passed";
    const parsed = parseAudit(result);
    if (!parsed || parsed.error) return "Unavailable";
    return parsed.findings.length ? "FindingsReported" : "UnknownFailure";
  },
  extractFindings(result) {
    const parsed = parseAudit(result);
    return parsed && !parsed.error && result.exitCode !== 0 ? parsed.findings : undefined;
  },
};

/** The delegate JSON contract this classifier understands; a different version is never guessed at. */
const delegatePreviewSchemaVersion = "1";
const delegateModes = new Set(["workspace", "range", "commit"]);

interface DelegatePreview {
  schema_version?: unknown;
  mode?: unknown;
  total_files?: unknown;
  reviewable_count?: unknown;
  excluded_count?: unknown;
  reviewable_files?: unknown;
  excluded_files?: unknown;
}

interface ReviewScope {
  mode: string;
  totalFiles: number;
  reviewable: number;
  excluded: number;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const paths = (value: unknown): value is { path: string }[] =>
  Array.isArray(value) && value.every((file) => !!file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string");

/** Parses `ocr delegate preview --format json`; undefined whenever the output cannot be trusted as a scope. */
export function parseReviewScope(result: ExecResult): ReviewScope | undefined {
  if (result.truncated) return undefined;
  let doc: unknown;
  try { doc = JSON.parse(result.stdout); } catch { return undefined; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const preview = doc as DelegatePreview;
  if (preview.schema_version !== delegatePreviewSchemaVersion) return undefined;
  if (typeof preview.mode !== "string" || !delegateModes.has(preview.mode)) return undefined;
  const { total_files: total, reviewable_count: reviewable, excluded_count: excluded } = preview;
  if (!count(total) || !count(reviewable) || !count(excluded)) return undefined;
  if (!paths(preview.reviewable_files) || !paths(preview.excluded_files)) return undefined;
  // The report must account for every changed file; a self-inconsistent one is not evidence.
  if (reviewable + excluded !== total || preview.reviewable_files.length !== reviewable || preview.excluded_files.length !== excluded) return undefined;
  return { mode: preview.mode, totalFiles: total, reviewable, excluded };
}

/**
 * ADR-0083: OpenCodeReview delegation mode (`ocr delegate preview --format json`). Deterministic file selection with
 * an exclusion reason per file, no LLM and no OCR provider config. The outcome asserts that the review scope was
 * determined against the pinned base commit — never that the review found nothing. A missing CLI or unparseable
 * output is a policy gap, not a pass (ADR-0042).
 */
export const ocrDelegatePreviewClassifier: CheckResultClassifier = {
  format: "ocr-delegate-preview",
  classify(result) {
    const terminated = terminationOutcome(result);
    if (terminated) return terminated;
    if (result.exitCode !== 0) {
      // The CLI is not installed in this runtime: an actionable outcome instead of a generic failure. Deliberately
      // narrower than "not found" so a real git/tool error stays a failure.
      return result.exitCode === 127 || /ocr: (command )?not found/i.test(result.stderr) ? "Unavailable" : "UnknownFailure";
    }
    const scope = parseReviewScope(result);
    if (!scope) return "NotVerified";
    // A base that compared nothing, or a change set with nothing reviewable, would make the scope evidence of nothing.
    return scope.totalFiles > 0 && scope.reviewable > 0 ? "Passed" : "NotVerified";
  },
};

export function registerCheckResultClassifiers(registrar: Registrar<CheckResultClassifier>): void {
  registrar.register(exitCodeClassifier.format, exitCodeClassifier);
  registrar.register(goTestJsonClassifier.format, goTestJsonClassifier);
  registrar.register(nodeTestTapClassifier.format, nodeTestTapClassifier);
  registrar.register(npmAuditJsonClassifier.format, npmAuditJsonClassifier);
  registrar.register(ocrDelegatePreviewClassifier.format, ocrDelegatePreviewClassifier);
}

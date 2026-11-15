import type { CheckOutcome } from "../model/kinds.ts";
import type { CheckResultClassifier } from "../ports/verification.ts";
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

/** Node's TAP diagnostics distinguish assertion errors from module loading and infrastructure failures. */
export const nodeTestTapClassifier: CheckResultClassifier = {
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
    if (!failed || cancelled || result.stderr.trim()) return "UnknownFailure";
    const failures = [...result.stdout.matchAll(/^not ok \d+ - .*?\r?\n([\s\S]*?^  \.\.\.\r?$)/gm)];
    if (!failures.length || failures.some((match) =>
      !/^  failureType: 'testCodeFailure'\r?$/m.test(match[1]) ||
      !/^  code: 'ERR_ASSERTION'\r?$/m.test(match[1]) ||
      !/^  name: 'AssertionError'\r?$/m.test(match[1]))) return "UnknownFailure";
    return "AssertionFailed";
  },
  failureEvidence(result) {
    if (this.classify(result) !== "AssertionFailed") return undefined;
    return exactTests([...result.stdout.matchAll(/^not ok \d+ - (.*?)\r?\n([\s\S]*?^  \.\.\.\r?$)/gm)].map((match) => match[1]));
  },
};

export function registerCheckResultClassifiers(registrar: Registrar<CheckResultClassifier>): void {
  registrar.register(exitCodeClassifier.format, exitCodeClassifier);
  registrar.register(goTestJsonClassifier.format, goTestJsonClassifier);
  registrar.register(nodeTestTapClassifier.format, nodeTestTapClassifier);
}

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
};

export function registerCheckResultClassifiers(registrar: Registrar<CheckResultClassifier>): void {
  registrar.register(exitCodeClassifier.format, exitCodeClassifier);
  registrar.register(goTestJsonClassifier.format, goTestJsonClassifier);
}

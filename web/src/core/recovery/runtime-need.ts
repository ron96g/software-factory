import type { CheckRun } from "../model/kinds.ts";
import type { ExecutionEnvironmentSelector, RecoveryNeedHandler } from "../ports/index.ts";

/** A model may name a runtime need only when the persisted failure and current runtime health prove it. */
export function runtimeRecoveryNeed(environments: ExecutionEnvironmentSelector): RecoveryNeedHandler {
  return {
    type: "sandbox-runtime",
    async inspect({ trigger, need }) {
      if (trigger.kind !== "CheckRun") return "invalid";
      const check = trigger as CheckRun;
      if (check.status?.outcome !== "Unavailable" || check.spec.environment.runtime !== need.runtime ||
          need.options.length !== 2 || need.options[0] !== "Restore runtime" || need.options[1] !== "Stop" ||
          need.recommendation !== "Restore runtime") return "invalid";
      await environments.refresh();
      const selection = await environments.select();
      const health = selection.candidates.find((candidate) => candidate.runtime === need.runtime);
      if (!health) return "invalid";
      return health.available ? "satisfied" : "needed";
    },
    resolve({ need, answer }) {
      if (answer === need.recommendation) return "resume";
      if (answer === "Stop") return "stop";
      return "invalid";
    },
  };
}

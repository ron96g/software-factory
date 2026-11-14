import { nsOf } from "../model/meta.ts";
import { isStoreError, type Controller, type EventRecorder, type InitialKeys, type Redactor, type ResourceReader, type RetrospectiveInvestigator } from "../ports/index.ts";

export function createRetrospectiveController(reader: ResourceReader, investigator: RetrospectiveInvestigator, events: EventRecorder, redactor: Redactor): Controller & InitialKeys {
  return {
    name: "retrospectives", watches: ["RetrospectiveFeedback", "AgentRun", "WorkItem"], resyncMs: 60_000,
    keysFor: (e) => [`${nsOf(e.object)}/retrospectives`],
    initialKeys: async () => [...new Set((await reader.list("RetrospectiveFeedback")).map((r) => `${nsOf(r)}/retrospectives`))],
    async reconcile(key) {
      try { await investigator.reconcile(key.split("/")[0]); }
      catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        const feedback = (await reader.list("RetrospectiveFeedback", { namespace: key.split("/")[0] }))[0];
        if (feedback) await events.warning(feedback, "RetrospectiveFailed",
          redactor.redact(`Investigation reconciliation failed; retrying with backoff: ${e instanceof Error ? e.message : String(e)}`));
        throw e;
      }
    },
  };
}

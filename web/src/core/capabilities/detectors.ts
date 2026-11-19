import type { CapabilityDetector, CapabilityFacts } from "../ports/index.ts";

const PULL_REQUEST_ACTIONS = new Set(["open-pull-request"]);
const TICKET_ACTIONS = new Set(["service-desk-reply", "ticket-transition"]);
const usedOutbox = (f: CapabilityFacts, actions: Set<string>) => f.outbox.some((m) => actions.has(m.spec.action));
const detector = (detect: (f: CapabilityFacts) => boolean): CapabilityDetector => ({ detect });

/** Built-in item capabilities (ADR-0075), registered by name in the composition root. */
export const BUILTIN_CAPABILITY_DETECTORS: Record<string, CapabilityDetector> = {
  planning: detector((f) => !!f.workflow?.planning),
  verification: detector((f) => !!f.workflow?.verification),
  checks: detector((f) => !!f.workflow?.verification || !!f.workflow?.stages.some((s) => s.gate?.checks?.length) || f.checkRuns.length > 0),
  "unit-execution": detector((f) => !!f.workflow?.unitExecution || f.runs.some((r) => r.spec.assignment?.kind === "unit")),
  "pull-requests": detector((f) => !!f.workflow?.stages.some((s) => s.publish?.pullRequest) || usedOutbox(f, PULL_REQUEST_ACTIONS)),
  "ticket-actions": detector((f) => {
    const writeBack = f.source?.spec.writeBack;
    const declared = !!f.workItem.spec.externalRef && (!!writeBack?.replyVisibilities?.length || writeBack?.transitions === true);
    return declared || usedOutbox(f, TICKET_ACTIONS);
  }),
  retrospective: detector((f) => !!f.workItem.spec.retrospective),
};


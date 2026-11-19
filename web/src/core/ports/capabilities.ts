import type { AgentRun, CheckRun, OutboxMessage, Source, WorkItem } from "../model/kinds.ts";
import type { CompiledWorkflow } from "./workflow.ts";

/** What an item's workflow, Source and own records say about it (ADR-0075). */
export interface CapabilityFacts {
  workItem: WorkItem;
  /** Absent when the item has no workflow or it doesn't compile. */
  workflow?: CompiledWorkflow;
  source?: Source;
  runs: AgentRun[];
  checkRuns: CheckRun[];
  outbox: OutboxMessage[];
}

/**
 * Decides one item capability (ADR-0075), registered under the capability's name. Pure.
 * "Declared or used": present when the workflow/Source declares the feature or the item already has records of it.
 */
export interface CapabilityDetector {
  detect(facts: CapabilityFacts): boolean;
}

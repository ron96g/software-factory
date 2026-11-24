import { createHash } from "node:crypto";
import type { FactoryEvent, IssueProposal, Repository, WorkItem } from "../model/kinds.ts";
import type { FlakyEvidence } from "../model/flaky.ts";
import { API_VERSION } from "../model/resource.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import { resolveRef } from "../refs/refs.ts";
import { isStoreError, type Clock, type EventRecorder, type FlakyTestReporter, type Redactor, type ResourceReader, type ResourceWriter } from "../ports/index.ts";
import { LABEL_WORKITEM } from "../runtime/event-recorder.ts";

export const FLAKY_TEST_EVENT = "FlakyTest";
/** ADR-0086 §6: this many flaky decisions for one test within the window propose one issue. */
export const FLAKY_ISSUE_THRESHOLD = 3;
const WINDOW_MS = 7 * 24 * 3_600_000;

const key = (check: string, test: string) => `${check} › ${test}`;

/** Events are the durable record: one Warning per (decision, test), counted across items for the issue threshold. */
export class EventFlakyTestReporter implements FlakyTestReporter {
  private readonly d: { reader: ResourceReader; writer: ResourceWriter; events: EventRecorder; clock: Clock; redactor: Redactor };
  constructor(d: EventFlakyTestReporter["d"]) {
    this.d = d;
  }

  async report(item: WorkItem, check: string, evidence: FlakyEvidence): Promise<void> {
    const ns = nsOf(item);
    const recorded = await this.d.reader.list<FactoryEvent>("Event", { namespace: ns, labelSelector: { [LABEL_WORKITEM]: item.metadata.name } });
    const decision = evidence.runs.join(", ");
    for (const test of evidence.tests) {
      const message = this.d.redactor.redact(`${key(check, test)}: failed and passed on the same snapshot (${decision})`);
      if (recorded.some((e) => e.spec.reason === FLAKY_TEST_EVENT && e.spec.message === message)) continue;
      await this.d.events.warning(item, FLAKY_TEST_EVENT, message);
      await this.proposeIfRepeated(item, check, test);
    }
  }

  private async proposeIfRepeated(item: WorkItem, check: string, test: string) {
    const ns = nsOf(item);
    const since = this.d.clock.now().getTime() - WINDOW_MS;
    const prefix = this.d.redactor.redact(`${key(check, test)}:`);
    const hits = (await this.d.reader.list<FactoryEvent>("Event", { namespace: ns }))
      .filter((e) => e.spec.reason === FLAKY_TEST_EVENT && e.spec.message.startsWith(prefix) && Date.parse(e.metadata.creationTimestamp ?? "") >= since);
    if (hits.length < FLAKY_ISSUE_THRESHOLD) return;
    const [repositoryName] = check.split("/");
    const repository = await resolveRef<Repository>(this.d.reader, "Repository", { name: repositoryName }, ns);
    const name = `flaky-${createHash("sha256").update(key(check, test)).digest("hex").slice(0, 20)}`;
    if (await this.d.reader.get<IssueProposal>("IssueProposal", ns, name)) return;
    const r = this.d.redactor;
    try {
      await this.d.writer.create<IssueProposal>({
        apiVersion: API_VERSION, kind: "IssueProposal",
        metadata: { name, namespace: ns, ownerReferences: [ownerRef(item)] },
        spec: {
          purpose: "finding",
          ...(repository?.spec.issueTrackerRef ? { targetRef: repository.spec.issueTrackerRef } : {}),
          title: r.redact(`Flaky test: ${test}`).slice(0, 200),
          body: r.redact([
            `The test \`${test}\` of \`${check}\` failed and passed again on the same code ${hits.length} times in the last 7 days.`,
            "Each time the factory had to re-run the check before it could continue, and items waited.",
            "",
            "## Evidence",
            ...hits.slice(-10).map((e) => `- ${e.spec.message}`),
            "",
            "## Likely causes",
            "- Shared state between tests, or cleanup racing background work (e.g. temp folders still being written).",
            "- Timing assumptions that fail under load.",
          ].join("\n")),
          labels: ["flaky-test"],
          pickUp: false,
          provenance: { proposedBy: "factory:flaky-tests", workItem: item.metadata.name, proposedAt: this.d.clock.now().toISOString() },
        },
      });
    } catch (e) {
      if (!isStoreError(e, "AlreadyExists")) throw e;
    }
  }
}

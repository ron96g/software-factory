import type { AgentRun, CheckRun } from "../model/kinds.ts";
import { nsOf } from "../model/meta.ts";
import type { ContextProvider, Redactor, ResourceReader } from "../ports/index.ts";
import { recoveryFailureSignature } from "./router.ts";

/** Present authoritative identifiers and the signature the diagnostic report must reproduce. */
export function recoveryContext(d: { reader: ResourceReader; redactor: Redactor }): ContextProvider {
  return {
    name: "recovery",
    appliesTo: (ctx) => ctx.run.spec.recovery?.mode === "diagnosis",
    async provide(ctx) {
      const assignment = ctx.run.spec.recovery!;
      const episode = ctx.workItem.status?.recovery?.find((e) => e.id === assignment.episode);
      const trigger = await d.reader.get<AgentRun | CheckRun>(assignment.trigger.kind, nsOf(ctx.workItem), assignment.trigger.name);
      if (!episode || episode.workItemUid !== ctx.workItem.metadata.uid || !trigger ||
          trigger.metadata.uid !== assignment.trigger.uid ||
          !trigger.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.uid === ctx.workItem.metadata.uid)) {
        return [{ title: "Recovery evidence unavailable", source: "recovery", content: "The episode or its trigger is unavailable. Do not invent evidence or report a successful recovery." }];
      }
      const content = [
        "Diagnose this failure using permitted read-only tools and authorized diagnostic checks. Do not edit files or claim that a diagnostic check satisfies readiness.",
        `Episode: ${episode.id}`,
        `Approved plan: ${episode.planFingerprint}; Unit: ${episode.unit}; policy: ${episode.policyVersion}`,
        `Trigger: ${trigger.kind}/${trigger.metadata.name}, UID ${trigger.metadata.uid}, resourceVersion ${trigger.metadata.resourceVersion}`,
        `Failure signature: ${recoveryFailureSignature(trigger)}`,
        `Recorded trigger outcome: ${trigger.kind === "CheckRun" ? (trigger as CheckRun).status?.outcome ?? "unavailable" : (trigger as AgentRun).status?.result?.outcome ?? (trigger as AgentRun).status?.message ?? "unavailable"}`,
        "Produce the required recovery-report JSON, include the exact trigger as evidence, and separate facts from hypotheses. A recommendation is not authorization.",
      ].join("\n");
      return [{ title: "Recovery diagnosis", source: "recovery", content: d.redactor.redact(content) }];
    },
  };
}

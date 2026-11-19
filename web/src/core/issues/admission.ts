import { createHash } from "node:crypto";
import type { IssueProposal, Source, WorkItem } from "../model/kinds.ts";
import { SYSTEM_NAMESPACE } from "../model/resource.ts";
import type { Validator } from "../ports/index.ts";

/** The fields a human approves; anything else (review, resolution, status) may change without invalidating approval. */
export function publishingFields(spec: IssueProposal["spec"]) {
  return {
    targetRef: spec.targetRef?.name, title: spec.title, body: spec.body, issueType: spec.issueType,
    labels: spec.labels, pickUp: spec.pickUp ?? false, relatesTo: spec.relatesTo, parent: spec.parent, purpose: spec.purpose, revision: spec.revision,
  };
}

export function issueContentHash(spec: IssueProposal["spec"]): string {
  return createHash("sha256").update(JSON.stringify(publishingFields(spec))).digest("hex");
}

const FROZEN = new Set(["Creating", "Created", "Uncertain", "Failed"]);

export function issueProposalValidator(): Validator {
  return {
    name: "issue-proposal-invariants",
    appliesTo: (kind) => kind === "IssueProposal",
    async validate(obj, ctx) {
      const p = obj as IssueProposal, old = ctx.oldObject as IssueProposal | undefined;
      const problems: string[] = [];
      const ns = p.metadata.namespace ?? "default";
      if (!p.spec.title || !p.spec.body) problems.push("title and body are required");

      if (p.spec.review?.decision === "approve") {
        if (!old && !p.spec.provenance?.human) problems.push("agents cannot create approved issue proposals");
        const target = p.spec.targetRef ? (await ctx.reader.get<Source>("Source", ns, p.spec.targetRef.name)) ?? (await ctx.reader.get<Source>("Source", SYSTEM_NAMESPACE, p.spec.targetRef.name)) : null;
        if (!target?.spec.writeBack?.issues) problems.push("approval needs a target Source with writeBack.issues");
      }

      if (!old && p.spec.purpose === "follow-up") {
        const itemName = p.spec.provenance?.workItem;
        const item = itemName ? await ctx.reader.get<WorkItem>("WorkItem", ns, itemName) : null;
        if (!itemName || !item) problems.push("a follow-up proposal must reference an existing work item");
        else {
          if (!p.metadata.name.startsWith(`${itemName}-followup-`)) problems.push(`the follow-up proposal must be named ${itemName}-followup-<requestId>`);
          if (!p.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.name === itemName)) problems.push("a follow-up proposal must be owned by its work item");
        }
        if (!p.spec.revision) problems.push("a follow-up proposal needs the preview revision");
        if (p.spec.review?.decision === "approve" && p.spec.review.contentHash !== issueContentHash(p.spec)) problems.push("the approval does not match the follow-up content");
      }

      if (old && old.status?.phase && FROZEN.has(old.status.phase) &&
        JSON.stringify(publishingFields(old.spec)) !== JSON.stringify(publishingFields(p.spec))) {
        problems.push(`publishing fields are frozen once the proposal is ${old.status.phase}`);
      }

      if (!old && p.spec.purpose === "mirror") {
        const itemName = p.spec.provenance?.workItem;
        const item = itemName ? await ctx.reader.get<WorkItem>("WorkItem", ns, itemName) : null;
        if (!itemName || !item) problems.push("a mirror proposal must reference an existing work item");
        else {
          if (p.metadata.name !== `${itemName}-mirror`) problems.push(`the mirror proposal must be named ${itemName}-mirror (one per item)`);
          if (item.spec.externalRef) problems.push("the work item already has an externalRef; it cannot be mirrored");
        }
      }
      return problems;
    },
  };
}

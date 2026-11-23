import { createHash } from "node:crypto";
import type { Approval, Artifact, IssueProposal, Source, WorkItem } from "../model/kinds.ts";
import { SYSTEM_NAMESPACE } from "../model/resource.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
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

      // ADR-0077: a story ticket is published only from the exact draft a human approved at the gate.
      if (!old && p.spec.purpose === "story") {
        const pv = p.spec.provenance;
        const itemName = pv?.workItem;
        const item = itemName ? await ctx.reader.get<WorkItem>("WorkItem", ns, itemName) : null;
        const approval = pv?.approval ? await ctx.reader.get<Approval>("Approval", ns, pv.approval) : null;
        const artifact = pv?.artifact ? await ctx.reader.get<Artifact>("Artifact", ns, pv.artifact.name) : null;
        if (!itemName || !item) problems.push("a story ticket must reference an existing work item");
        else {
          if (p.metadata.name !== `${itemName}-ticket`) problems.push(`the story ticket must be named ${itemName}-ticket (one per item)`);
          if (!p.metadata.ownerReferences?.some((o) => o.kind === "WorkItem" && o.name === itemName)) problems.push("a story ticket must be owned by its work item");
        }
        if (!pv?.human) problems.push("a story ticket is published on behalf of the human who approved it");
        if (!approval || approval.spec.decision !== "approve" || approval.spec.workItemRef.name !== itemName || approval.metadata.labels?.[LABEL_SUPERSEDED]) {
          problems.push("a story ticket needs a current approved gate decision of its work item");
        } else if (!approval.spec.decidedBy || approval.spec.decidedBy !== pv?.proposedBy || approval.spec.decidedBy !== p.spec.review?.by) {
          problems.push("a story ticket is approved on behalf of the human who decided the gate");
        }
        if (!artifact || artifact.metadata.uid !== pv?.artifact?.uid || artifact.metadata.resourceVersion !== pv?.artifact?.resourceVersion || artifact.spec.workItemRef.name !== itemName) {
          problems.push("a story ticket needs the exact draft version of its work item");
        } else if (approval && (artifact.metadata.creationTimestamp ?? "") > (approval.metadata.creationTimestamp ?? "")) {
          problems.push("the draft was written after the approval it claims");
        }
        if (p.spec.review?.decision !== "approve" || p.spec.review.contentHash !== issueContentHash(p.spec)) problems.push("the approval does not match the story ticket content");
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

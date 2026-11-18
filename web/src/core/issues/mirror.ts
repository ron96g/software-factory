import type { IssueProposal, Source, WorkItem } from "../model/kinds.ts";
import type { MirrorLinkChecker, ResourceReader } from "../ports/index.ts";

export const LABEL_EXTERNAL_REF = "factory.ai-dlc.io/external-ref";
const MARKER = /\[software-factory:issue-([^\]\s]+)\]/;

export const isLinked = (p: IssueProposal) => !!p.status?.conditions?.some((c) => c.type === "Linked" && c.status === "True");
export const mirrorItemName = (p: IssueProposal) => p.spec.provenance?.workItem ?? p.metadata.name.replace(/-mirror$/, "");
export const externalRefLabel = (source: string, id: string) => `${source}.${id}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 63);

export function mirrorLinkChecker(d: { reader: ResourceReader }): MirrorLinkChecker {
  return {
    async isUnlinkedMirror(description) {
      const uid = description?.match(MARKER)?.[1];
      if (!uid) return false;
      const proposals = await d.reader.list<IssueProposal>("IssueProposal");
      const p = proposals.find((x) => x.metadata.uid === uid && x.spec.purpose === "mirror");
      return !!p && p.status?.phase !== "Rejected" && !isLinked(p);
    },
  };
}

export type { Source, WorkItem };

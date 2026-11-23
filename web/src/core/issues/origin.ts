import type { IssueProposal } from "../model/kinds.ts";
import { DEFAULT_NAMESPACE } from "../model/resource.ts";
import type { FollowUpOrigin, FollowUpOriginResolver, Redactor, ResourceReader, WorkItemRecordReader } from "../ports/index.ts";
import { followUpPreview } from "../app/work-item-followups.ts";

const MARKER = /\[software-factory:issue-([^\]\s]+)\]/;
const MAX_CONTEXT = 20_000;

export interface OriginDeps { reader: ResourceReader; records: WorkItemRecordReader; redactor: Redactor; clock: { now(): Date } }

/** Same bounded, redacted evidence as the ADR-0039 preview; null when the origin item is gone. */
export async function originOf(d: OriginDeps, p: IssueProposal): Promise<FollowUpOrigin | null> {
  const name = p.spec.provenance?.workItem;
  const ns = p.metadata.namespace ?? DEFAULT_NAMESPACE;
  if ((p.spec.purpose !== "follow-up" && p.spec.purpose !== "story") || !name) return null;
  if (!(await d.reader.get("WorkItem", ns, name))) return null;
  const preview = followUpPreview(await d.records.read(ns, name), "", d.redactor, d.clock.now().toISOString(), MAX_CONTEXT);
  return { originWorkItemRef: { name }, originSnapshot: preview.snapshot };
}

export function followUpOriginResolver(d: OriginDeps): FollowUpOriginResolver {
  return {
    async resolve(description) {
      const uid = description?.match(MARKER)?.[1];
      if (!uid) return null;
      const p = (await d.reader.list<IssueProposal>("IssueProposal")).find((x) => x.metadata.uid === uid && (x.spec.purpose === "follow-up" || x.spec.purpose === "story"));
      return p ? originOf(d, p) : null;
    },
  };
}

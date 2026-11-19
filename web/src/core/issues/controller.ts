import type { IssueProposal, IssueProposalStatus, OutboxMessage, Source, WorkItem } from "../model/kinds.ts";
import { SYSTEM_NAMESPACE } from "../model/resource.ts";
import { keyOf, nsOf, ownerRef, parseKey } from "../model/meta.ts";
import { canFindIssues, canReadIssueStatus, isStoreError, type Clock, type Controller, type EventRecorder, type InitialKeys, type Lookup, type Outbox, type ResourceReader, type ResourceWriter, type SourceConnector, type StatusWriter } from "../ports/index.ts";
import { issueContentHash } from "./admission.ts";
import { issueMarker } from "./handler.ts";
import { externalRefLabel, isLinked, LABEL_EXTERNAL_REF, mirrorItemName } from "./mirror.ts";

/** Lookups after an unknown outcome (ADR-0066 §4): 1, 5 and 15 minutes after the failure was first seen. */
export const LOOKUP_DELAYS_MS = [60_000, 300_000, 900_000];
function pollIntervalMs(v?: string): number {
  const m = /^(\d+)\s*(s|m|h)$/.exec(v ?? "");
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] : 300_000;
}
export const createKey = (name: string, attempt: number) => `${name}-create-a${attempt}`;
const resolutionKey = (r: NonNullable<IssueProposal["spec"]["resolution"]>) => `${r.action}|${r.externalId ?? ""}|${r.at ?? ""}`;

/** ADR-0066: owns IssueProposal.status. Claim before effect; the outbox performs the single POST. */
export function createIssueProposalController(d: { reader: ResourceReader; status: StatusWriter; events: EventRecorder; clock: Clock; outbox: Outbox; connectors: Lookup<SourceConnector>; workItems?: ResourceWriter }): Controller & InitialKeys {
  const linkPending = (p: IssueProposal) => p.spec.purpose === "follow-up" && !p.status?.conditions?.some((c) => c.type === "Linked");
  const trackable = (p: IssueProposal) => p.spec.purpose === "follow-up" && p.status?.tracked?.open !== false && !!p.status?.externalRef?.externalId;
  const phaseOk = (p: IssueProposal) => p.status?.phase === "Created" ? (p.spec.purpose === "mirror" && !isLinked(p)) || linkPending(p) || trackable(p) : true;
  /** ADR-0068: read-only refresh of the created ticket, at most once per Source pollInterval; stops when the tracker reports it closed. */
  async function track(p: IssueProposal, st: IssueProposalStatus, write: (n: IssueProposalStatus, r?: string, m?: string, w?: boolean) => Promise<void>) {
    if (!trackable(p)) return;
    const ns = nsOf(p);
    const source = await d.reader.get<Source>("Source", ns, p.spec.targetRef!.name) ?? await d.reader.get<Source>("Source", SYSTEM_NAMESPACE, p.spec.targetRef!.name);
    const connector = source ? d.connectors.get(source.spec.type) : undefined;
    if (!source || !connector || !canReadIssueStatus(connector)) return;
    const interval = pollIntervalMs(source.spec.sync?.pollInterval);
    const now = d.clock.now().getTime();
    const last = st.tracked?.readAt ? Date.parse(st.tracked.readAt) : NaN;
    if (!Number.isNaN(last) && now - last < interval) return { requeueAfterMs: interval - (now - last) };
    try {
      const s = await connector.readIssueStatus(source, st.externalRef!.externalId);
      await write({ ...st, tracked: { state: s.state, open: s.open, assignee: s.assignee, updatedAt: s.updatedAt, readAt: new Date(now).toISOString() } });
      return s.open ? { requeueAfterMs: interval } : undefined;
    } catch (err) {
      await d.events.warning(p, "IssueTrackingFailed", err instanceof Error ? err.message : String(err));
      return { requeueAfterMs: interval };
    }
  }
  /** ADR-0066 §6: writes the item's reference on the human's behalf; a different existing reference is never overwritten. */
  async function linkMirror(p: IssueProposal, st: IssueProposalStatus, write: (n: IssueProposalStatus, r?: string, m?: string, w?: boolean) => Promise<void>) {
    const ns = nsOf(p);
    const item = await d.reader.get<WorkItem>("WorkItem", ns, mirrorItemName(p));
    const ref = st.externalRef;
    if (!item || !ref?.externalId) return { requeueAfterMs: 30_000 };
    const source = p.spec.targetRef!.name;
    const other = item.spec.externalRef && (item.spec.externalRef.id !== ref.externalId || item.spec.sourceRef?.name !== source);
    const others = (st.conditions ?? []).filter((c) => c.type !== "Linked");
    if (other) {
      if (st.conditions?.some((c) => c.type === "Linked" && c.reason === "Conflict")) return;
      const message = `work item already references ${item.spec.sourceRef?.name}/${item.spec.externalRef!.id}; created issue is ${source}/${ref.externalId}`;
      return await write({ ...st, conditions: [...others, { type: "Linked", status: "False", reason: "Conflict", message }] }, "MirrorConflict", message, true);
    }
    const label = externalRefLabel(source, ref.externalId);
    if (item.spec.externalRef?.id !== ref.externalId || item.metadata.labels?.[LABEL_EXTERNAL_REF] !== label) {
      await d.workItems!.update<WorkItem>({
        ...item,
        metadata: { ...item.metadata, labels: { ...item.metadata.labels, [LABEL_EXTERNAL_REF]: label } },
        spec: { ...item.spec, sourceRef: { name: source }, externalRef: { id: ref.externalId, url: ref.url } },
      });
    }
    await write({ ...st, conditions: [...others, { type: "Linked", status: "True", reason: "Linked" }] }, "MirrorLinked", `work item linked to ${ref.externalId}`);
  }
  /** ADR-0068: optional Jira link to the origin; the ticket stays Created whatever happens here. */
  async function linkOrigin(p: IssueProposal, st: IssueProposalStatus, write: (n: IssueProposalStatus, r?: string, m?: string, w?: boolean) => Promise<void>) {
    const ns = nsOf(p);
    const done = async (status: "True" | "False", reason: string, message: string | undefined, event?: string, warn = false) =>
      write({ ...st, conditions: [...(st.conditions ?? []).filter((c) => c.type !== "Linked"), { type: "Linked", status, reason, message }] }, event, message ?? reason, warn);
    const getSource = async (n: string) => await d.reader.get<Source>("Source", ns, n) ?? await d.reader.get<Source>("Source", SYSTEM_NAMESPACE, n);
    const target = await getSource(p.spec.targetRef!.name);
    if (!target?.spec.writeBack?.issues?.linkOrigin) return await done("False", "NotRequested", undefined);
    const item = p.spec.provenance?.workItem ? await d.reader.get<WorkItem>("WorkItem", ns, p.spec.provenance.workItem) : null;
    const originRef = item?.spec.externalRef?.id;
    const origin = item?.spec.sourceRef ? await getSource(item.spec.sourceRef.name) : null;
    const base = (s: Source) => String(s.spec.connection?.baseUrl ?? "").replace(/\/+$/, "").toLowerCase();
    if (!originRef || !origin || origin.spec.type !== target.spec.type || !base(origin) || base(origin) !== base(target)) {
      return await done("False", "NoSameInstanceOrigin", "origin ticket is not on the same tracker instance");
    }
    const key = `${p.metadata.name}-link`;
    await d.outbox.enqueue({
      key, namespace: ns, source: target.metadata.name, action: "link-issue", owner: ownerRef(p),
      payload: { namespace: ns, proposal: p.metadata.name, proposalUid: p.metadata.uid, from: st.externalRef!.externalId, to: originRef },
    });
    const msg = await d.reader.get<OutboxMessage>("OutboxMessage", ns, key);
    if (msg?.status?.phase === "Delivered") return await done("True", "Linked", undefined, "IssueLinked");
    if (msg?.status?.phase === "Failed") return await done("False", "LinkFailed", msg.status.lastError, "IssueLinkFailed", true);
    return { requeueAfterMs: 2000 };
  }
  return {
    name: "issueproposal",
    primaryKind: "IssueProposal",
    watches: ["IssueProposal", "OutboxMessage"],
    keysFor: (e) => {
      if (e.type === "DELETED") return [];
      if (e.object.kind === "IssueProposal") return [keyOf(e.object)];
      const owner = e.object.metadata.ownerReferences?.find((o) => o.kind === "IssueProposal");
      return owner ? [`${nsOf(e.object)}/${owner.name}`] : [];
    },
    initialKeys: async () => (await d.reader.list<IssueProposal>("IssueProposal")).filter(phaseOk).map(keyOf),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const p = await d.reader.get<IssueProposal>("IssueProposal", namespace, name);
      if (!p) return;
      const now = d.clock.now();
      const st: IssueProposalStatus = p.status ?? { phase: "Proposed" };
      const write = async (next: IssueProposalStatus, reason?: string, message?: string, warn = false) => {
        const updated = await d.status.updateStatus<IssueProposal>({ ...p, status: next });
        if (reason) await (warn ? d.events.warning : d.events.normal).call(d.events, updated, reason, message ?? reason);
      };
      try {
        const resolution = p.spec.resolution;
        if ((st.phase === "Uncertain" || st.phase === "Failed") && resolution && st.resolved !== resolutionKey(resolution)) {
          const resolved = resolutionKey(resolution);
          if (resolution.action === "link" && resolution.externalId) {
            await write({ ...st, phase: "Created", externalRef: { externalId: resolution.externalId }, resolved, lookup: undefined }, "IssueCreated", `linked to existing issue ${resolution.externalId}`);
          } else if (resolution.action === "create-again") {
            await write({ ...st, phase: "Creating", attempt: (st.attempt ?? 1) + 1, resolved, lookup: undefined, externalRef: undefined }, "IssueCreating", "creating again by human decision");
            return { requeueAfterMs: 0 };
          }
          return;
        }
        if (st.phase === "Created" && linkPending(p)) return await linkOrigin(p, st, write);
        if (st.phase === "Created" && p.spec.purpose === "mirror" && d.workItems && !isLinked(p)) return await linkMirror(p, st, write);
        if (st.phase === "Created" && p.spec.purpose === "follow-up") return await track(p, st, write);
        if (st.phase === "Created" || st.phase === "Uncertain" || st.phase === "Failed") return;
        if (st.phase !== "Creating") {
          if (p.spec.review?.decision === "reject") return st.phase === "Rejected" ? undefined : await write({ phase: "Rejected" }, "IssueRejected", "rejected");
          if (p.spec.review?.decision !== "approve") return st.phase === "Proposed" ? undefined : await write({ phase: "Proposed" });
          if (p.spec.review.contentHash !== issueContentHash(p.spec) || !p.spec.targetRef) {
            if (st.conditions?.some((c) => c.type === "Approved" && c.status === "False")) return;
            return await write({ ...st, phase: "Proposed", conditions: [{ type: "Approved", status: "False", reason: "StaleApproval", message: "the approval does not match the current content or has no target" }] }, "IssueApprovalStale", "approval ignored: content changed or no target", true);
          }
          await write({ phase: "Creating", attempt: 1, approved: { contentHash: p.spec.review.contentHash, at: p.spec.review.at ?? now.toISOString(), by: p.spec.review.by } }, "IssueApproved", `approved${p.spec.review.by ? ` by ${p.spec.review.by}` : ""}`);
          return { requeueAfterMs: 0 };
        }
        // Creating: the claim is persisted before the effect is enqueued.
        const attempt = st.attempt ?? 1;
        const target = p.spec.targetRef!.name;
        await d.outbox.enqueue({
          key: createKey(name, attempt), namespace, source: target, action: "create-issue", owner: ownerRef(p),
          payload: { namespace, proposal: name, proposalUid: p.metadata.uid, contentHash: st.approved!.contentHash, attempt },
        });
        const msg = await d.reader.get<OutboxMessage>("OutboxMessage", namespace, createKey(name, attempt));
        if (msg?.status?.phase === "Delivered") {
          const r = msg.status.result ?? {};
          await write({ ...st, phase: "Created", lookup: undefined, externalRef: { externalId: String(r.externalId ?? ""), url: typeof r.url === "string" ? r.url : undefined } }, "IssueCreated", `created ${r.externalId ?? ""}`);
          return;
        }
        if (msg?.status?.phase !== "Failed") return { requeueAfterMs: 2000 };
        if (!msg.status.attempts) return await write({ ...st, phase: "Failed", conditions: [{ type: "Created", status: "False", reason: "DeliveryBlocked", message: msg.status.lastError }] }, "IssueFailed", msg.status.lastError ?? "blocked", true);
        // Unknown outcome: look up on a schedule; never POST again automatically.
        const lookup = st.lookup ?? { since: now.toISOString(), count: 0 };
        const due = Date.parse(lookup.since) + LOOKUP_DELAYS_MS[lookup.count];
        if (!st.lookup) { await write({ ...st, lookup }); return { requeueAfterMs: LOOKUP_DELAYS_MS[0] }; }
        if (now.getTime() < due) return { requeueAfterMs: due - now.getTime() };
        const source = await d.reader.get<Source>("Source", namespace, target);
        const connector = source ? d.connectors.get(source.spec.type) : undefined;
        let found: { externalId: string; url?: string }[] = [];
        if (source && connector && canFindIssues(connector)) {
          found = await connector.findCreatedIssues(source, { marker: issueMarker(p.metadata.uid!), createdAfter: st.approved!.at });
        }
        if (found.length === 1) return await write({ ...st, phase: "Created", lookup: undefined, externalRef: found[0] }, "IssueCreated", `found ${found[0].externalId} by lookup`);
        const count = lookup.count + 1;
        if (found.length > 1 || count >= LOOKUP_DELAYS_MS.length) {
          return await write({ ...st, phase: "Uncertain", lookup: { ...lookup, count }, conditions: [{ type: "Created", status: "Unknown", reason: found.length > 1 ? "AmbiguousLookup" : "NotFound", message: `${found.length} matching issues found after ${count} lookups` }] }, "IssueUncertain", "outcome unknown; a human must link the issue or create again", true);
        }
        await write({ ...st, lookup: { ...lookup, count } });
        return { requeueAfterMs: Math.max(0, Date.parse(lookup.since) + LOOKUP_DELAYS_MS[count] - now.getTime()) };
      } catch (err) {
        if (isStoreError(err, "Conflict")) return { requeueAfterMs: 0 };
        throw err;
      }
    },
  };
}

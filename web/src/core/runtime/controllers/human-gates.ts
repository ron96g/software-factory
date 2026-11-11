import type { Approval, Clarification } from "../../model/kinds.ts";
import { keyOf, parseKey } from "../../model/meta.ts";
import { isStoreError, type Clock, type Controller, type ResourceReader, type StatusWriter } from "../../ports/index.ts";

/** Derives Clarification.status from the human-written spec (answers). */
export function createClarificationController(d: { reader: ResourceReader; status: StatusWriter; clock: Clock }): Controller {
  return {
    name: "clarification",
    watches: ["Clarification"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const c = await d.reader.get<Clarification>("Clarification", namespace, name);
      if (!c) return;
      const phase = c.spec.answers?.length ? "Answered" : "Open";
      if (c.status?.phase === phase) return;
      try {
        await d.status.updateStatus({ ...c, status: { phase, answeredAt: phase === "Answered" ? d.clock.now().toISOString() : undefined } });
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}

/** Derives Approval.status from the human decision. */
export function createApprovalController(d: { reader: ResourceReader; status: StatusWriter }): Controller {
  return {
    name: "approval",
    watches: ["Approval"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const a = await d.reader.get<Approval>("Approval", namespace, name);
      if (!a) return;
      const phase = a.spec.decision === "approve" ? "Approved" : a.spec.decision === "reject" ? "Rejected" : "Pending";
      if (a.status?.phase === phase) return;
      try {
        await d.status.updateStatus({ ...a, status: { phase } });
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}

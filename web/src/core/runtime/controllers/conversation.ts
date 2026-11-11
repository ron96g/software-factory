import type { Conversation } from "../../model/kinds.ts";
import { keyOf, parseKey } from "../../model/meta.ts";
import {
  isStoreError,
  type Controller,
  type ResourceReader,
  type StatusWriter,
  type TranscriptRecorderFactory,
} from "../../ports/index.ts";

/** Owns Conversation.status: opens its transcript once (ADR-0012). */
export function createConversationController(d: {
  reader: ResourceReader;
  status: StatusWriter;
  recorders: TranscriptRecorderFactory;
}): Controller {
  return {
    name: "conversation",
    primaryKind: "Conversation",
    watches: ["Conversation"],
    keysFor: (e) => (e.type === "DELETED" ? [] : [keyOf(e.object)]),
    async reconcile(key) {
      const { namespace, name } = parseKey(key);
      const c = await d.reader.get<Conversation>("Conversation", namespace, name);
      if (!c || c.status?.transcriptRef) return;
      const rec = await d.recorders.forConversation(c);
      try {
        await d.status.updateStatus({ ...c, status: { transcriptRef: rec.ref } });
      } catch (e) {
        if (isStoreError(e, "Conflict")) return { requeueAfterMs: 0 };
        throw e;
      }
    },
  };
}

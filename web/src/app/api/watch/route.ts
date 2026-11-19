import { getFactory } from "@/server/factory-instance.ts";
import { principalFrom } from "@/server/http.ts";
import type { FactoryEvent } from "@/core/model/kinds.ts";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: emits a lightweight change notice per store event (kind/name/workitem).
 * Clients refetch what they display. New Events worth a human's attention are also sent as
 * `{ type: "notification", notification }` frames (ADR-0069). v0.4 will filter by the principal's namespaces.
 */
export async function GET(req: Request) {
  await principalFrom(req);
  const f = await getFactory();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const send = (data: unknown) => {
        if (open) controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      send({ type: "hello" });
      const unsubscribe = f.watcher.watch((e) => {
        const o = e.object;
        const workItem =
          o.kind === "WorkItem" ? o.metadata.name : o.metadata.ownerReferences?.find((r) => r.kind === "WorkItem")?.name ?? o.metadata.labels?.["factory.ai-dlc.io/workitem"];
        send({ type: e.type, kind: o.kind, name: o.metadata.name, workItem });
        if (e.type === "ADDED" && o.kind === "Event") {
          void f.notificationClassifier
            .classify(o as FactoryEvent)
            .then((notification) => notification && send({ type: "notification", notification }))
            .catch(() => {});
        }
      });
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000);
      cleanup = () => {
        open = false;
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}

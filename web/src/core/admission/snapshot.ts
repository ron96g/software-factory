import type { Resource } from "../model/resource.ts";
import { nsOf, matchesLabels, clone } from "../model/meta.ts";
import type { Admitter, ResourceReader } from "../ports/index.ts";

/** Admit a whole candidate snapshot: every definition must pass the real chain against the candidate as reader. */
export function snapshotAdmit(admitter: Admitter) {
  return async (candidate: readonly Resource[]): Promise<string | undefined> => {
    const reader = {
      get: async (kind: string, namespace: string, name: string) => {
        const r = candidate.find((i) => i.kind === kind && nsOf(i) === namespace && i.metadata.name === name);
        return r ? clone(r) : null;
      },
      list: async (kind: string, o: { namespace?: string; labelSelector?: any } = {}) =>
        candidate.filter((i) => i.kind === kind && (!o.namespace || nsOf(i) === o.namespace) && matchesLabels(i, o.labelSelector)).map((i) => clone(i)),
    } as unknown as ResourceReader;
    for (const d of candidate) {
      try {
        await admitter.admit(d, { operation: "UPDATE", oldObject: d, reader });
      } catch (e) {
        return (e as Error).message;
      }
    }
    return undefined;
  };
}

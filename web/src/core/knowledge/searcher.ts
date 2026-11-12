import type { KnowledgeEntry, KnowledgeScope, KnowledgeSource } from "../model/kinds.ts";
import { DEFAULT_NAMESPACE, SYSTEM_NAMESPACE } from "../model/resource.ts";
import type { KnowledgeHit, KnowledgeQuery, KnowledgeSearcher, KnowledgeSourceSearch, Lookup, Redactor, ResourceReader } from "../ports/index.ts";
import { knowledgePhase } from "../runtime/controllers/knowledge.ts";

/** Every non-empty dimension must match (AND); an empty scope applies everywhere. */
const inScope = (repos: string[], workflows: string[], q: KnowledgeQuery) =>
  (!repos.length || repos.some((r) => q.repositories?.includes(r))) && (!workflows.length || (!!q.workflow && workflows.includes(q.workflow)));
const sourceInScope = (scope: KnowledgeScope | undefined, q: KnowledgeQuery) =>
  inScope(scope?.repositoryRefs?.map((r) => r.name) ?? [], scope?.workflowRefs?.map((r) => r.name) ?? [], q);

const count = (haystack: string, term: string) => haystack.split(term).length - 1;

/** ADR-0030: approved entries (keyword scoring) + knowledge sources in scope. Never returns unapproved entries. */
export class DefaultKnowledgeSearcher implements KnowledgeSearcher {
  private readonly d: { reader: ResourceReader; sources: Lookup<KnowledgeSourceSearch>; redactor: Redactor; namespace?: string };
  constructor(d: DefaultKnowledgeSearcher["d"]) {
    this.d = d;
  }

  async searchKnowledge(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
    const limit = q.limit ?? 8;
    const terms = [...new Set(q.terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 1))];
    if (!terms.length) return [];

    const entries = (await this.d.reader.list<KnowledgeEntry>("KnowledgeEntry", { namespace: this.d.namespace ?? DEFAULT_NAMESPACE }))
      // Both: the controller's status and the human's current spec (a just-retired entry must not be served).
      .filter((e) => e.status?.phase === "Approved" && knowledgePhase(e) === "Approved")
      .filter((e) => inScope(e.spec.scope?.repositories ?? [], e.spec.scope?.workflows ?? [], q))
      .map((e) => {
        const title = e.spec.title.toLowerCase();
        const tags = (e.spec.tags ?? []).join(" ").toLowerCase();
        const content = e.spec.content.toLowerCase();
        const score = terms.reduce((s, t) => s + 3 * count(title, t) + 2 * count(tags, t) + Math.min(count(content, t), 5), 0);
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ e }): KnowledgeHit => ({ kind: "entry", title: e.spec.title, ref: e.metadata.name, excerpt: e.spec.content.slice(0, 1500) }));

    const docs: KnowledgeHit[] = [];
    for (const source of await this.d.reader.list<KnowledgeSource>("KnowledgeSource", { namespace: SYSTEM_NAMESPACE })) {
      if (!sourceInScope(source.spec.scope, q) || docs.length >= limit) continue;
      const search = this.d.sources.get(source.spec.type);
      if (!search) {
        // Visible, not silent: the hit tells the agent (and the transcript) why this source is missing.
        docs.push({ kind: "doc", title: `${source.metadata.name}: unavailable`, ref: source.metadata.name, excerpt: `no search registered for type "${source.spec.type}"` });
        continue;
      }
      try {
        docs.push(...(await search.search(source, terms, limit - docs.length)));
      } catch (e) {
        docs.push({ kind: "doc", title: `${source.metadata.name}: unavailable`, ref: source.metadata.name, excerpt: e instanceof Error ? e.message : String(e) });
      }
    }
    // Defence in depth (ADR-0015): human edits and external docs were never redacted at write time.
    return [...entries, ...docs].map((h) => ({ ...h, title: this.d.redactor.redact(h.title), excerpt: this.d.redactor.redact(h.excerpt) }));
  }
}

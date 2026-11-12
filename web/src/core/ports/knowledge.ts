/**
 * Knowledge base (ADR-0030): approved agent knowledge + external docs. Read side only; writes go through the
 * resource store (proposals by the AgentRun controller, reviews and edits by humans).
 */
import type { KnowledgeSource } from "../model/kinds.ts";

export interface KnowledgeHit {
  kind: "entry" | "doc";
  title: string;
  /** Entry name, or `source:path:line` for docs. */
  ref: string;
  excerpt: string;
}

export interface KnowledgeQuery {
  terms: string[];
  /** The run's repositories / workflow; entries and sources scoped elsewhere are skipped. */
  repositories?: string[];
  workflow?: string;
  limit?: number;
}

/** Searches approved entries and the knowledge sources in scope. Read-only. */
export interface KnowledgeSearcher {
  searchKnowledge(q: KnowledgeQuery): Promise<KnowledgeHit[]>;
}

/** Search for one `KnowledgeSource.spec.type` (registered; e.g. `files` = ripgrep, later a vector store). */
export interface KnowledgeSourceSearch {
  readonly type: string;
  search(source: KnowledgeSource, terms: string[], limit: number): Promise<KnowledgeHit[]>;
}

import type { KnowledgeSourceSpec } from "../model/kinds.ts";

/** Effective access of a KnowledgeSource: absent means read-only; any other value is rejected. */
export function knowledgeSourceAccess(spec: Pick<KnowledgeSourceSpec, "access">): "read-only" {
  const a = (spec as { access?: unknown }).access;
  if (a === undefined || a === "read-only") return "read-only";
  throw new Error(`KnowledgeSource access must be "read-only", got ${JSON.stringify(a)}`);
}

import type { SourceHistory, WorkItem } from "../model/kinds.ts";
import { FACTORY_COMMENT_MARKER } from "../ports/index.ts";

export const PROMPT_HISTORY_BUDGET = 24_000;
export const DIGEST_HISTORY_BUDGET = 6_000;

type Entry = { at: string; text: string };

/**
 * The source ticket's conversation and change history for agents (ADR-0070), chronological. Over budget, the
 * oldest entries are dropped (the newest state of the conversation matters most) and the omission is stated.
 */
export function renderSourceHistory(wi: WorkItem, budget: number): string {
  const h: SourceHistory | undefined = wi.spec.sourceHistory;
  if (!h) return "";
  const source = `${wi.spec.sourceRef.name}${wi.spec.externalRef ? ` ${wi.spec.externalRef.id}` : ""}`;
  const entries: Entry[] = [
    ...h.comments.map((c) => ({
      at: c.createdAt,
      text: `### ${c.createdAt} · ${c.author} · ${c.byFactory ? "factory · " : ""}${c.visibility === "internal" ? "INTERNAL comment" : "public comment"}${c.updatedAt ? ` (edited ${c.updatedAt})` : ""}\n${c.body.split(FACTORY_COMMENT_MARKER).join("").trim() || "(empty)"}`,
    })),
    ...h.changes.map((c) => ({ at: c.at, text: `- ${c.at} · ${c.author}: ${c.field}: ${c.from ?? "∅"} → ${c.to ?? "∅"}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i].text;
    if (used + text.length + 1 <= budget) {
      kept.unshift(text);
      used += text.length + 1;
      continue;
    }
    // Even the newest entry must fit: clip it rather than blow the budget.
    if (!kept.length) kept.unshift(`${text.slice(0, Math.max(0, budget - 40))} …[truncated for length]`);
    break;
  }
  const dropped = entries.length - kept.length + (h.omitted?.comments ?? 0) + (h.omitted?.changes ?? 0);
  const internal = h.comments.some((c) => c.visibility === "internal");
  return [
    `## Ticket history (${source}, fetched ${h.fetchedAt})`,
    `${h.comments.length} comment(s) and ${h.changes.length} field change(s), oldest first. This is what the requester and the team already said and did: use it, and don't ask for what it answers.` +
      (internal ? " INTERNAL comments are visible to the service-desk team only: never quote or reveal them in anything the requester will see." : ""),
    ...(dropped ? [`(${dropped} older entr${dropped === 1 ? "y" : "ies"} omitted for length.)`] : []),
    ...(entries.length ? kept : ["(no comments or changes yet)"]),
  ].join("\n");
}

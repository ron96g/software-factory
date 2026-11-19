import type { FactoryEvent } from "../model/kinds.ts";
import type { NotificationContext, NotificationDraft, NotificationRule, NotificationSeverity, Registrar } from "../ports/index.ts";
import { ruleKey } from "./classifier.ts";

type Link = (e: FactoryEvent, ctx: NotificationContext) => string;

const itemLink: Link = (_e, ctx) => (ctx.workItem ? `/items/${encodeURIComponent(ctx.workItem)}` : "/");
const prUrl = (e: FactoryEvent) => /·\s*(https?:\/\/\S+)/.exec(e.spec.message)?.[1];

const withItem = (ctx: NotificationContext, message: string) => (ctx.workItemTitle ? `${ctx.workItemTitle}: ${message}` : message);

function rule(
  severity: NotificationSeverity,
  category: string,
  title: string,
  opts: { link?: Link; message?: (e: FactoryEvent) => string; when?: (e: FactoryEvent) => boolean } = {},
): NotificationRule {
  return {
    toNotification(e, ctx): NotificationDraft | null {
      if (opts.when && !opts.when(e)) return null;
      return { severity, category, title, message: withItem(ctx, opts.message?.(e) ?? e.spec.message), link: (opts.link ?? itemLink)(e, ctx) };
    },
  };
}

/**
 * The catalog of what is worth telling a human (ADR-0069 §3). Reasons not listed here (Started, StageStarted,
 * CheckFailed, DeliveryRetry, Approved/Rejected, …) only appear in the timeline.
 */
export function registerNotificationRules(r: Registrar<NotificationRule>): void {
  const add = (kind: string, reason: string, impl: NotificationRule) => r.register(ruleKey(kind, reason), impl);

  // action: the item stays stuck until a human acts
  add("WorkItem", "Blocked", rule("action", "clarification", "Clarification needed"));
  add("WorkItem", "RecoveryHumanNeed", rule("action", "clarification", "Clarification needed"));
  add("WorkItem", "AwaitingApproval", rule("action", "approval", "Approval needed"));
  add("WorkItem", "PlanningNeedsAttention", rule("action", "attention", "Planning needs attention"));
  add("AgentRun", "KnowledgeProposed", rule("action", "knowledge", "Knowledge to review", { link: () => "/knowledge" }));
  add("AgentRun", "IssueProposed", rule("action", "issue", "Issue proposals to review"));

  // problem: something went wrong
  for (const reason of ["Failed", "GateFailed", "RecoveryUnavailable"]) add("WorkItem", reason, rule("problem", "failed", "Work item failed"));
  add("WorkItem", "AgentRunFailed", rule("problem", "failed", "Agent run failed"));
  add("WorkItem", "LoopExhausted", rule("problem", "loop", "Review loop exhausted"));
  add("WorkItem", "RecoveryExhausted", rule("problem", "failed", "Automatic recovery exhausted"));
  add("AgentRun", "ModelUnavailable", rule("problem", "quota", "Waiting for model quota"));
  add("*", "ReconcileFailing", rule("problem", "controller", "Control loop failing"));
  for (const reason of ["DeliveryBlocked", "DeliveryFailed"]) add("OutboxMessage", reason, rule("problem", "write-back", "Write-back failed"));

  // info: good to know
  add("WorkItem", "Completed", rule("info", "done", "Work item done"));
  add("WorkItem", "AnsweredAtSource", rule("info", "answered", "Answered on the issue"));
  add("*", "ReconcileRecovered", rule("info", "controller", "Control loop recovered"));
  add(
    "OutboxMessage",
    "Delivered",
    rule("info", "pull-request", "Draft PR opened", {
      when: (e) => e.spec.message.startsWith("open-pull-request"),
      link: (e, ctx) => prUrl(e) ?? itemLink(e, ctx),
      message: (e) => prUrl(e) ?? e.spec.message,
    }),
  );
  add(
    "Source",
    "Synced",
    rule("info", "sync", "New work items", {
      when: (e) => Number(/^(\d+) created/.exec(e.spec.message)?.[1] ?? 0) > 0,
      message: (e) => `${e.spec.involvedObject.name}: ${e.spec.message}`,
      link: () => "/",
    }),
  );
  add(
    "Conversation",
    "ChatAnswered",
    rule("info", "chat", "Agent answered", { link: (e) => `/chats/${encodeURIComponent(e.spec.involvedObject.name)}` }),
  );
}

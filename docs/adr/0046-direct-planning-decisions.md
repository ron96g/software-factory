# ADR-0046: Directly answerable planning decisions

- **Status:** Accepted; amended in part by ADR-0048 (AI plan review findings are advisory)
- **Date:** 2026-11-14
- **Deciders:** project owner
- **Supersedes:** ADR-0045

## Context
ADR-0045 tried to prevent repeated agent interviews with a shared one-batch budget. When a regenerated proposal
introduced required decisions, this locked the answer controls while those same decisions blocked approval.
Reopening discovery added a human action and a full regeneration before the human could even answer.
The owner requested removing this lock and making approval blockers actionable.

## Decision
- Retain ADR-0045's opt-in workflow, resource reuse, autonomous drafting, consolidated decision sheet, immutable
  proposal history, exact-revision approval, safe revision boundaries and all existing verification/publication gates.
  Replace only its decision-budget and mandatory-reopening policy.
- At a safe human stop, required decisions are directly answerable without unlocking or reopening discovery, including
  on existing WorkItems with `batchSubmitted: true`. Humans can also correct previously submitted answers.
- Preserve answers whose question/options/required semantics are unchanged. Changed semantics require a fresh answer,
  not a new discovery cycle. Each submission includes all currently unresolved required decisions together; existing
  valid answers need not be resubmitted.
- **Submit answers & update plan** saves human intent and regenerates requirements onward once. It never approves
  the plan. The human reviews and explicitly approves the generated result; earlier approvals remain unusable.
- Avoid interview loops through agent behavior, not by locking the human's controls: research discoverable facts,
  reuse supplied answers, use visible recommended defaults for reversible details, and consolidate genuinely
  consequential human-only decisions at the durable review surface. Do not silently default required decisions.
  Further essential uncertainty remains visible and directly answerable, not an automatic per-agent interview.
- Approval guidance states the actual next action: answer outstanding required decisions, submit unsaved answers or
  edits, wait for the in-flight revision, or address the specific stale/missing evidence or review findings.
- Reuse `PlanningQueries`, `PlanningCommands` and their existing DTOs. Retain the original `reopen` command and
  persisted discovery/batch fields for old clients and retry receipts, but no current UI or submission requires them.
  No new resource, controller, interface method, approval bypass or database migration is needed.

## Consequences
- AGENTS.md X26 and the planning documentation describe consolidated submissions without a one-batch lock.
- Existing blocked items become answerable without mutating their stored answers, restarting them or approving them.
- Tests cover subsequent submissions, new and changed decisions, preserved answers, optimistic retries, fresh approval
  and the absence of automatic Clarification interviews.
- New material uncertainty can still block approval. Removing the lock does not authorize an agent to invent answers,
  waive required evidence, repeatedly re-ask settled choices or proceed without human approval.

## Alternatives considered
- Move or relabel **Reopen discovery**: rejected because the redundant unlock and regeneration remain.
- Automatically reopen and regenerate when new questions appear: rejected because it adds latency without human input.
- Ignore new required decisions or implicitly approve defaults: rejected because this weakens human authority and safety.
- Remove all legacy fields/actions: unnecessary; accepting old receipts avoids disrupting existing clients.

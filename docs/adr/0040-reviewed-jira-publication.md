# ADR-0040: Reviewed service-desk publication and ticket transitions

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0005, ADR-0027, ADR-0029

## Context
Service desk investigations currently end with an approved draft that humans post manually. Operators need a
subsequent reviewed publication step, explicit customer-visible/internal comments, and Jira status transitions.
Enabling bidirectional synchronization would also enable unsolicited clarification posting and is not sufficient.

## Decision
- X21 adds a registered `ticket-publication` gate after `response-review`. A fresh durable Approval captures the
  exact current response artifact, UID/version, source, ticket and item identity. Humans review it, explicitly choose
  public reply or internal note, and optionally select a Jira transition. Generic approval cannot bypass this review.
- Only after this fresh approval do registered outbox handlers publish the response and then the optional transition.
  The workflow finishes only after delivery. Reject returns to drafting. Superseded/replay output is ineligible.
- Existing completed items are not automatically reopened or published. A human can start the new publication review
  from the existing approved response without re-running investigation. Historical approvals never authorize posting.
- Source `writeBack.replyVisibilities` and `writeBack.transitions` explicitly permit these reviewed actions.
  `sync.bidirectional` remains false for service desk: automatic questions and comment-answer synchronization stay off.
  Outbox source authorization is a deny-by-default registry by action; existing comment policy still requires
  bidirectional sync. The Jira adapter independently enforces the corresponding permission.
- JSM replies use `/rest/servicedeskapi/request/{key}/comment` with an explicit `public` boolean.
  Comments carry a visible deterministic factory receipt marker for crash recovery. Bodies are posted as reviewed
  text; no promise of automatic Markdown-to-Jira formatting conversion is made.
- Status changes use Jira's actual available transition IDs and target statuses, never assumed names or guessed IDs.
  The UI supports an explicitly confirmed status-only action as well as a transition after a published response.
  Transitions needing extra Jira form fields are shown but cannot be submitted by this MVP.
  Read the current status and available transitions again before sending; stale state fails visibly.
- Human-only commands carry Principal and namespace, optimistic concurrency and preview revisions. New actions are
  not exposed as MCP/agent tools. Publication delivery revalidates the approval, artifact, source and current round.
- New recoverable actions persist `Delivering` before POST. On restart, observe the receipt marker or target status
  instead of repeating the write. Errors or unconfirmed outcomes fail visibly and require human inspection/review;
  no blind automatic POST retries. Existing ordinary-comment/PR retry behavior is preserved.

## Consequences
- AGENTS.md X21, workflow/source definitions, glossary and architecture are updated.
- The service desk source is read-only for automatic sync, but explicitly supports reviewed human publication/status
  actions. This extends X11's original manual-posting scope without changing other sources' write permissions.
- Jira account permissions and deployment-specific transitions still apply. Implementation/tests never post to a real
  ticket. No new resource kind, worker lease or unreviewed agent mutation is introduced.
- A response may be delivered while its subsequent transition fails; the UI preserves both receipts and reports the
  partial outcome rather than reposting the comment.

## Alternatives considered
- Turn on bidirectional sync: conflates clarification automation with reviewed publication and lacks visibility.
- Publish from the agent or directly in HTTP: bypasses durable approval or outbox delivery.
- Reuse old approvals after deployment: could unexpectedly publish previously completed investigations.
- Blindly retry ambiguous POSTs: can duplicate customer replies or repeat a transition.

# ADR-0056: Owner-led peer feedback before construction

- **Status:** Proposed
- **Date:** 2026-11-15
- **Deciders:** project owner
- **Builds on:** ADR-0002, ADR-0005, ADR-0006, ADR-0009, ADR-0011, ADR-0012, ADR-0025,
  ADR-0046, ADR-0050, ADR-0051, ADR-0055

## Context
Plans and designs benefit from peer feedback before implementation makes changes expensive. Today a human can
edit planning intent or decide a gate, but there is no distinct peer discussion with an accountable owner deciding
which suggestions should steer agents. Putting every comment into additional context would make discussion
binding before the owner has agreed, and would lose the distinction between a suggestion and an instruction.

The desired collaboration model is one owner per WorkItem, with peers able to comment on the plan, design and
other artifacts. The owner can discuss, accept or reject each suggestion. Accepted feedback must reach the next
relevant AgentRun, without modifying an in-flight prompt or silently changing already-approved evidence.

## Decision
### 1. One accountable owner, with authenticated collaborators
- A collaboration-enabled WorkItem has exactly one human owner through `spec.ownerRef`, referencing the `User`
  identity from ADR-0009. This is accountability, not a Kubernetes `ownerReference`: deleting a User must not
  cascade-delete their work. Ownership does not grant namespace access or gate-approver roles.
- Human-created items default to their authenticated creator. Synced and existing items can remain unassigned;
  an authorized human must explicitly claim or assign them before collaboration is enabled. Never guess an owner
  from a source username or an agent identity. Transfer is an explicit, audited command available to the owner or
  an authorized administrator, with optimistic concurrency; it preserves all discussion and prior decisions.
- Peers with access to the item's namespace and collaboration permission can read and add feedback and replies.
  Only the current owner can accept or reject peer feedback. Administrative recovery can transfer ownership,
  not impersonate an owner's decision. Owners still need the existing role to approve a workflow gate.
- Commands accept a request-scoped `Principal`; actor identity and timestamps are server-attributed, never trusted
  from request-body display names. Apply these checks to generic resource writes as well as dedicated APIs.
  Agents, source synchronization and existing machine MCP tokens cannot act as the human owner.
- Multi-user enablement requires trusted OIDC identity and server-side authorization from ADR-0009, including
  namespace-scoped reads and writes. Unauthenticated deployments keep their existing single-user behavior and
  cannot enable peer collaboration. This proposal does not implement auth or silently end ADR-0025's postponement;
  scheduling its prerequisite and accepting this ADR are explicit steps before implementation.

### 2. Durable feedback threads, separate from agent conversations
- Introduce a proposed runtime kind, `FeedbackThread`, in the WorkItem's namespace and owned by that WorkItem
  through `metadata.ownerReferences`; deletion follows the item's normal cascade lifecycle.
- Human-written `spec` holds a `workItemRef`, an immutable target and append-only discussion/decision entries.
  Targets identify the item or a stage, and optionally an Artifact by typed reference plus UID, resource version,
  content digest and a section/decision anchor. A plan target pins its proposal revision; a design target pins its
  producing AgentRun and artifact. Anchors aid navigation; exact revision identity determines freshness.
- Peers and the owner can reply. A decision entry records accept/reject, the exact message IDs considered, the
  current target revision, owner identity, time and rationale. Acceptance includes explicit owner-approved
  incorporation instructions; these may quote a suggestion or clarify what part is accepted. Rejection requires a
  reason. Later replies cannot alter an earlier decision's meaning. Corrections are new entries, not edits to history.
- The initial disposition is open. Accepted or rejected threads remain readable and replyable; a new actionable
  suggestion after disposition uses a linked new thread. Reversing accepted guidance likewise needs a new explicit
  owner decision and revision, never deletion of the historical input.
- Only the WorkItem controller writes thread `status`, through `StatusWriter`: observed disposition, stale target,
  queued revision, and the revision/run references that actually consumed accepted input. Human decisions stay in
  `spec`; controller observations never rewrite them. A recorded input is not proof the agent implemented it.
- All mutations use resource versions and idempotent request IDs. Admission validates same-namespace references,
  append-only history, actor permissions and unchanged immutable fields. Cross-resource commands revalidate owner
  identity/version when committing, so a concurrent transfer cannot authorize a former owner's decision.

### 3. Acceptance is revision intent, not approval
- Open discussion, rejected suggestions and replies do not enter workflow agent prompts. They do not block
  progress by themselves or satisfy a required planning decision. Owners may request peer review at existing
  plan/design stops, but this increment adds no mandatory peer quorum or new approval gate.
- Acceptance durably queues the exact owner-approved instructions for the next relevant workflow AgentRun.
  The queue survives restarts; it cannot be marked incorporated merely because an HTTP command succeeded.
  Pending accepted feedback blocks approval or advancement past its affected evidence until it has been applied
  and the regenerated result has passed the existing review and human gates.
- Apply revisions only at existing safe human stops: no active agents, checks or publication effects. Feedback
  can be discussed while work runs; accepted input is visibly queued, does not mutate active or already-created
  AgentRuns, and holds further affected run creation until the revision is materialized. An in-flight result cannot
  clear that hold. The UI distinguishes accepted/queued, included in a run, and awaiting review of the result.
- Plan feedback regenerates the proposal through the workflow's existing planning revision path and independent
  review. Design feedback reruns the architect's design step and reopens its human design gate; it cannot be sent
  only to the developer. Scope or validation-contract changes return to planning, even when raised on a design.
  The owner explicitly selects plan or design revision when accepting; unsupported targets/routes fail visibly.
- Design-only revision is allowed only while stopped before construction at the design gate. Feedback on
  already-approved upstream work requires an explicit existing amendment/restart path that invalidates dependent
  evidence. If that path is unavailable, the owner must create a follow-up instead; acceptance cannot claim that
  a future unrelated run will fix it. Terminal items require an explicit supported reopen or follow-up first.
- Reject stale acceptance attempts when the pinned proposal/artifact is no longer current. The owner must review
  the new evidence and explicitly re-anchor the suggestion; no fuzzy carry-forward of an undecided comment.
  Once accepted guidance is applied, its historical target remains pinned and its instructions remain part of
  the resulting revision's lineage, rather than becoming invalid merely because regeneration produced new artifacts.
- Coalesce compatible queued decisions into one revision at a safe stop. Use a deterministic application identity
  containing WorkItem UID, target revision, ordered accepted decision IDs and workflow round. Reconciliation or
  command retries cannot create duplicate revisions; conflicting routes/instructions require owner resolution,
  never an agent silently choosing which accepted instruction to discard.
- Acceptance racing a gate decision or AgentRun creation must be serialized through the same revision/advancement
  guard. Approval fingerprints bind the accepted-input revision as well as existing evidence; all advancement
  entry points recheck it. Neither a stale gate submission nor a direct restart can bypass pending accepted input.
  Multi-resource crashes recover from durable decision IDs and application records, not an in-memory queue.

### 4. Pin accepted input and make its use inspectable
- At run creation, pin an immutable, bounded snapshot of applicable accepted instructions and their thread/decision
  identities, owner decision, target evidence and application revision. Record the supplied context through
  `TranscriptRecorder` and run provenance. Retries reuse their pinned input; later decisions create a new revision.
  Downstream runs retain applicable accepted guidance through that revision's lineage.
- Keep peer-authored text labeled as human-provided, untrusted input. Acceptance does not grant tool permissions,
  waive validation, answer required decisions, override system policy, or authorize publication. Do not copy entire
  discussions into `spec.context` or treat a peer comment as a Clarification answer or Approval.
- Define explicit per-message and snapshot limits during implementation. Reject oversized input or require an
  owner-reviewed smaller batch; never silently truncate accepted instructions. Redaction and namespace isolation
  apply to discussion, snapshots, transcripts and APIs.
- Replays reuse the original accepted-input snapshot and cannot advance the workflow. Explain conversations stay
  side-effect free. Human peer discussion is not a new `Conversation` purpose or an unrecorded agent interaction.

### 5. Focused collaboration UX and implementation seams
- Show the owner on the dashboard and item header, with explicit claim/transfer controls where permitted.
  Put discussion alongside the plan, design or other targeted artifact, not in an unrelated global chat.
- A thread shows author/time, exact reviewed revision, replies, owner decision/reason and stale-target warnings.
  The owner sees open feedback and accept/reject actions with a preview of the instructions and revision route.
  Link accepted input to the run that consumed it and the regenerated artifact for human verification.
- Begin with plan and pre-construction design feedback. Item-level discussion is allowed, but acceptance must
  select a supported plan/design route. Inline code review, live co-editing, mentions, notifications, peer quorums
  and Jira/GitHub comment synchronization are out of scope. Future outbound notifications must use the outbox.
- Before runtime implementation, define segregated ownership, discussion, disposition and accepted-input query/
  application ports. Register the kind and context provider through existing registries, wire implementations
  only in the composition root, and reuse planning/restart and gate-binding ports instead of a second workflow engine.

## Consequences
- Peers can contribute early without gaining authority to steer agents or approve work. One human remains
  accountable for accepting guidance; existing product-owner and tech-lead gate roles are unchanged.
- Discussion and acceptance are auditable resources, not mutable artifact edits. Accepted input is delivered
  durably and visibly, but only regenerated evidence and subsequent reviews establish that it was addressed.
- Authentication/authorization is a prerequisite, not a cosmetic owner dropdown. This adds implementation cost
  and leaves unauthenticated single-user use unchanged until the prerequisites are delivered.
- AGENTS.md sections 1, 2 rule 9 and 4 will need implementation-time updates when this proposal is accepted and
  delivered. Section 4 tracks X36 as Proposed, not complete. The glossary and architecture distinguish proposed
  concepts from shipped resource kinds; this ADR alone adds no runtime kind, schema, API or dependency.

### Acceptance criteria for implementation
1. **AC-1:** An assigned item has one owner; claim/transfer is authorized and audited. Owner deletion cannot delete
   the item, and unassigned legacy/synced items behave unchanged until explicitly enabled.
2. **AC-2:** An authorized peer comments on a pinned plan/design and the owner replies and accepts/rejects with
   rationale. Non-owners and machine callers cannot decide, including through generic writes or transfer races.
3. **AC-3:** Open/rejected discussion never enters workflow prompts. Accepted instructions appear in the next
   relevant run's pinned context/provenance and survive restart without duplicate revisions or silent truncation.
4. **AC-4:** Active work is not mutated. Stale targets, unsupported routes and acceptance/approval races fail
   explicitly or remain visibly queued; no affected run or stale approval advances past unapplied accepted input.
5. **AC-5:** Plan feedback regenerates planning and review; design feedback regenerates design. Required human
   plan/design approvals, decision answers, current verification evidence and publication authorization remain
   enforced. Already-started construction requires an explicit amendment/restart or independent follow-up.
6. **AC-6:** Thread/run/result links distinguish queued input, delivered input and reviewed results; reply-after-
   acceptance cannot change pinned instructions. Namespace isolation, redaction, concurrent writes, crash recovery
   and historical replay are covered through the public app/API surface.

## Alternatives considered
- Feed all comments to agents automatically: discussion would become instruction without owner consent.
- Use only additional context or gate comments: no per-suggestion disposition, discussion history or exact target
  binding; peers would either edit shared intent directly or need gate permissions to contribute.
- Require every peer's approval: creates a new veto/quorum model rather than early advisory collaboration.
- Reuse agent Conversations for peer threads: conflates human discussion with model turns and their execution policy.
- Implement full squads, notifications and real-time co-editing together: unnecessary for the first focused slice;
  trusted identity and scoped authorization are required, but the wider collaboration suite is not.

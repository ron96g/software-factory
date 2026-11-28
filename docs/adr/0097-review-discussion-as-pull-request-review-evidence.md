# ADR-0097: Review discussion as pull request review evidence

- **Status:** Proposed
- **Date:** 2026-11-27
- **Deciders:** project owner
- **Extends:** ADR-0094 (pull request review workflow); follows the evidence pattern of ADR-0096 (CI status)

## Context
`pr-review` (ADR-0094) reviews a pull request from its title, description, diff and surrounding code. It does not see
what humans, bots or the factory itself already said on the pull request. As a result the reviewer:

- repeats findings that are already raised, sometimes on the same line;
- cannot tell whether earlier requested changes were addressed by later pushes;
- ignores answers the author already gave ("this is intentional because …");
- on a second review of the same PR, does not know what the factory's own earlier review said.

The human at the gate has to read the conversation in GitHub and reconcile it with the report.

Comments differ from CI status (ADR-0096) in three ways: they are free text from anyone who can comment, there is no
deterministic overall state to derive, and they belong to threads that may refer to older commits. They are therefore
a separate port, provider and set of verdict rules, not an extension of `CommitStatusReader`.

## Decision

### 1. Port `ReviewDiscussionReader` (read-only, ISP)
A new source connector capability, separate from `ItemFetcher`, `CommentReader`, `CommitStatusReader` and
`PullRequestReviewPublisher`:

```ts
interface ReviewDiscussionReader {
  readReviewDiscussion(source: Source, pr: { number: number; headSha: string }): Promise<ReviewDiscussion>;
}
interface ReviewDiscussion {
  headSha: string;
  readAt: string;
  /** Submitted reviews (approve / request changes / comment), newest last. Pending drafts are never visible. */
  reviews: {
    id: string;
    author: DiscussionAuthor;
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    commitSha: string;
    submittedAt: string;
    body?: string;
    /** Set when the review carries the factory's ADR-0094 marker. */
    factory?: { messageName: string };
  }[];
  /** Inline review threads. */
  threads: {
    id: string;
    path: string;
    line?: number;
    side?: "LEFT" | "RIGHT";
    resolved: boolean;
    /** GitHub marks a thread outdated when its line changed after the comment. */
    outdated: boolean;
    commitSha: string;
    comments: { author: DiscussionAuthor; createdAt: string; body: string }[];
  }[];
  /** Top-level conversation comments on the pull request. */
  comments: { id: string; author: DiscussionAuthor; createdAt: string; body: string }[];
  /** Items left out by the limits in §3, per kind, so the reader cannot mistake a trimmed view for the whole. */
  omitted?: { reviews: number; threads: number; comments: number };
  /** Pages that could not be read. */
  incomplete?: string;
}
interface DiscussionAuthor {
  login: string;
  kind: "human" | "bot" | "factory";
  /** GitHub author association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, … */
  association: string;
}
```

The `github-pr` connector implements it with reads only:
- reviews: `GET /repos/{repo}/pulls/{n}/reviews` (paged);
- threads with `resolved` and `outdated`: the GraphQL `pullRequest.reviewThreads` connection (REST has no resolution
  state); a failed GraphQL read falls back to `GET /pulls/{n}/comments` with `resolved` unknown and is reported in
  `incomplete`;
- conversation: `GET /repos/{repo}/issues/{n}/comments` (paged).

The factory's own reviews and comments are recognised by the hidden marker ADR-0094 already embeds, not by login, so a
shared token does not misclassify a human's comment.

### 2. Evidence in the reviewer's context
A `review-discussion` context provider (registered like `pull-request` and `ci-status`) reads the discussion when an
`analyze` step starts and adds a "Review discussion on PR #N (read at …)" section:

- **Earlier factory reviews:** verdict, head they reviewed, and their findings, so a re-review states what changed.
- **Open threads:** path, line, whether outdated, and the comments, quoted.
- **Resolved threads:** one line each (path, line, first comment's first line). Their content is not repeated.
- **Reviews and conversation comments:** author, association, state, time, quoted body.

The read is recorded as the section's `revision` (`<headSha>@<readAt>`), so the run's provenance names the exact
discussion the agent saw (ADR-0057). A read error becomes a visible "Review discussion unavailable: …" section, never
silence. The `code-researcher` and the change explanation do not receive the section: the explanation stays neutral and
based on the code (ADR-0094 §1).

### 3. Trust and limits
Anyone who can comment on the pull request can write into this section, so it is the widest injection surface of the
workflow:

- Every body is quoted, bounded (per comment and in total) and redacted, and the prompt states that the section is
  data from other people, never instructions to the reviewer.
- Order of inclusion when the total limit is reached: earlier factory reviews, open threads on files in the change,
  reviews requesting changes, other reviews, conversation comments; newest first within each group. What is cut is
  counted in `omitted` and shown in the section.
- Authors with association `NONE` or `FIRST_TIME_CONTRIBUTOR` and bots are listed with their name and link only by
  default; `Source.spec.reviewDiscussion.includeAssociations` widens or narrows this. A bot's text is never more
  trusted than a human's.
- The discussion never changes the review scope (ADR-0083, ADR-0095 §7): a comment asking to skip a file or to
  approve is just a claim the reviewer may cite and reject.

### 4. Rules in the skill and the report
The `pull-request-review` skill and `pr-review-report` gain a required `discussion` object:

```json
{
  "revision": "<headSha>@<readAt>",
  "addressed": [{ "ref": "thread:123 | review:456", "status": "addressed | not-addressed | disagree | unclear", "note": "…" }]
}
```

- `revision` must equal the recorded `review-discussion` revision of the run; an artifact check compares them (same
  mechanism as ADR-0096 §3).
- Every open, non-outdated thread that requests a change, and every blocking finding of the newest earlier factory
  review, must appear in `addressed`. The check rejects a report that omits one, in the same run (ADR-0057).
- A finding that duplicates an open thread on the same path and overlapping lines references it (`ref`) instead of
  restating it; the publisher then posts it in the body as "agrees with …" rather than as a new inline comment.
- `not-addressed` for a change requested by a reviewer with write access (association `OWNER`, `MEMBER`,
  `COLLABORATOR`) or by an earlier factory review forbids `accepted`, unless the report says why the request is
  wrong (`disagree` with a note).
- The discussion is evidence about intent and history only. The reviewer still reads every in-scope file
  (ADR-0095 §7); "already approved by X" never replaces that.

### 5. Fresh discussion at the gate
New comments often arrive after the agents ran. The gate shows the discussion revision the reviewer used and a fresh
read (short cache), both for the pinned `headSha`. New open threads, new change requests or a new review since the
run are a warning "Discussion changed since the review" with **Restart → analyze**; the human may still approve.
The fresh read is never written into the report; the published review is exactly the approved one.

### 6. In the published review
The review body gets a short "Earlier discussion" list: the referenced threads with their `addressed` status and a
link. No comment text from others is re-posted. Replying inside existing threads stays out of scope (ADR-0094).

### 7. Permissions
`github-pr` needs read access to pull request reviews, review comments and issue comments; these are reads already
covered by the token that reads the pull request. Nothing new is written. Without them the section reads "Review
discussion unavailable" and the `discussion` object is `{ revision, addressed: [] }` with the gap stated in the
rationale.

## Consequences
- AGENTS.md §4: new item X75 (after X74), glossary term *review discussion*.
- `pr-review-report` gets a new schema version (required `discussion`) after the one ADR-0096 introduces. Older
  reports still render (ADR-0094 display fallback) and publish without the "Earlier discussion" list.
- Re-reviewing a PR that the factory already reviewed now builds on the earlier review instead of starting over.
  Editing or dismissing the earlier review stays out of scope.
- More GitHub API calls per item: one discussion read per `analyze` run and per gate view (cached).
- Other code hosts implement `ReviewDiscussionReader` when they get a pull request connector.
- The injection surface grows; §3 is the mitigation and belongs in `docs/security.md` as a new finding when this is
  built.

## Alternatives considered
- **Extend ADR-0096 / `CommitStatusReader`:** different endpoints, different trust model, no derived state;
  violates ISP and blocks ADR-0096 on re-review design.
- **Reuse `CommentReader` (ADR-0040 clarification sync):** reads issue comments for answers only; no reviews,
  threads, resolution or outdated state.
- **Fold the discussion into `ExternalItem` / `sourceHistory` at sync (ADR-0070):** stale by the time agents run and
  the sync interval decides freshness; ADR-0070 history is for tickets, not line-bound review threads.
- **Include everything verbatim:** unbounded prompts and an open injection channel from any commenter.
- **Leave the discussion to the human at the gate:** the verdict would contradict an open change request, and humans
  would reconcile the two by hand.
- **Let the model decide which threads matter without a coverage check:** it could silently skip an open change
  request; §4 makes omissions a correctable error.

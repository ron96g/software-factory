# ADR-0023: Real automated checks and draft pull requests

- **Status:** Superseded by ADR-0042 for migrated verification contracts; Accepted for legacy checks and publication
- **Date:** 2026-11-11

## Context
Automated gates passed every check with a warning (MVP), and "ship" produced only a simulated release. A work item should
end in a reviewable pull request whose checks actually ran.

## Decision
### Checks
- Repositories declare check commands: `Repository.spec.checks: { <name>: "<command>" }`, e.g. `build: cd web && npx tsc --noEmit -p .`.
- The `automated` gate runs each `gate.checks[]` name through a **registered `GateCheck`**, or else through the repository's
  command of that name. Checks with neither still pass, with a warning event.
- Commands run **in the item's workspace through the selected sandbox runtime** (`CommandRunner` port). They run in the
  background, and the gate returns a new `wait` decision, so the controller never blocks (ADR-0005). Results are recorded as
  `CheckPassed`/`CheckFailed` events, with an output tail.
- On failure, `onFailure.retry.next` (e.g. `implement`) is used up to `maxAttempts`. After that, the item fails with the reason
  (escalation to a human comes with v0.4 roles).

### Pull requests
- A stage can declare `publish: { pullRequest: { draft: true } }`. On entering it, the WorkItem controller enqueues an
  `open-pull-request` **outbox** message per workspace (rule 7), with an idempotent key per stage round.
- The handler:
  1. commits the workspace changes as "Software Factory" through `BranchPublisher`;
  2. pushes `factory/<item>` with a token (sent via git config env, never on the command line);
  3. opens or reuses a **draft PR** through a `CodeHost` adapter selected by the repository's git URL (`github` first).
  The PR URL is stored in the outbox message's `status.result` and shown on the item page.
- `OutboxMessage.spec.sourceRef/externalId` become optional, because not every outbound effect targets a source item.
  `OutboxHandler.deliver` receives one message object and may return a result.
- Humans still approve `ship`. Merging is done by humans on the code host.

## Consequences
End-to-end: a work item produces a verified branch and a draft PR. Pushing needs a token with write access
(`Repository.spec.git.secretRef`).

## Addendum (architecture review of S5c)
- The verifier's verdict (LLM output) is **advisory**. It's quoted in the PR body, and the human `ship` gate decides. Enforcing it
  later would be a registered `GateCheck` (e.g. `verification-verdict`) with no core change.
- Check results are cached in memory per (item, stage, round), so **checks re-run after a restart**. Infrastructure errors
  (`CheckError`) are not cached and don't consume the retry budget. Check output is redacted before it's recorded.
- The `host` runtime keeps workspaces in `<repo>/.workspaces` (gitignored, outside the web app; `FACTORY_WORKSPACES_DIR`
  overrides it), so Next.js and `tsc` never see workspace copies of the code.
- Only https git URLs can be pushed. The token travels in an `http.<origin>.extraheader` set via environment variables.

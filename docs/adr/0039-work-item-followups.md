# ADR-0039: Independent follow-up WorkItems with reviewed context

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0032, ADR-0037

## Context
Service desk investigation can uncover work for another workflow. Changing the original item's workflow would mix
stage state, artifacts, source synchronization and approval history. The operator also needs to supply a new
objective and free-text instructions, separately from historical evidence.

## Decision
- A human uses **Create follow-up** to select a workflow and repositories, edit the title/description, add optional
  free-text instructions, and review inherited evidence before **Create & start workflow**.
- Create an independent manual-source WorkItem in the same runtime namespace. It starts at the selected workflow's
  beginning with its normal gates and workspace lifecycle. Never copy status, approvals, ownership, external source
  identity or write-back permissions. The origin remains unchanged.
- Store `originWorkItemRef` and an immutable `originSnapshot` (source UID/version, capture time, evidence versions,
  redacted bounded content and truncation flag). This is historical provenance, not a required live reference:
  creation validates the origin directly; generic live-reference admission deliberately does not walk this field.
  Deleting/recreating the origin cannot delete the follow-up, invalidate its updates or replace its historical identity.
- Store the operator's additional instructions separately in `spec.context`. Every agent receives those instructions
  and a distinct historical-evidence section. Preserve the instructions in full after secret redaction, rejecting
  over-limit input explicitly. Shorten inherited evidence first, with a visible marker. Their combined limit is
  20,000 characters; later context edits respect the remaining budget without rewriting the snapshot.
- Reuse the namespace-scoped evidence reader. Exclude superseded/replay runs and their artifacts, including artifacts
  produced after a run became superseded. Label inherited artifacts as historical evidence, not approval for the new
  workflow. Do not copy transcripts, previous origin snapshots or recursively expand handoff chains.
- Preview is side-effect free. A revision fingerprints the source/evidence versions and redacted instructions;
  creation re-reads them and rejects a stale preview explicitly. Reads are not a transactional snapshot.
  Refresh preserves the operator's edits. Source updates after the final check do not change the stored snapshot.
- Per-request deterministic naming and a persisted input fingerprint make retries idempotent while permitting multiple
  intentional follow-ups. A reused request ID with different input is a conflict. Lookup happens before re-reading the
  origin so a retry still succeeds if the origin changed or disappeared after creation.
- Show origin and follow-up links using namespace-scoped queries and an origin-UID label. Missing origins are visible
  as unavailable; recreating the same name does not attach old follow-ups to the new object.

## Consequences
- AGENTS.md X20 tracks implementation; glossary and architecture describe follow-ups.
- Narrow follow-up query/command ports precede implementation. Existing WorkItem creation validation and controllers
  are reused; no new resource kind, controller, automated handoff or agent-accessible MCP mutation is added.
- A new objective can build on reviewed findings without inheriting their workflow state or approval authority.
- Generic context updates on follow-ups have less free space when inherited evidence is large.

## Alternatives considered
- Replace the origin workflow: corrupts lifecycle assumptions and source ownership.
- Live evidence links: later changes silently alter the new item's agent context and deletion breaks execution.
- Copy all history into free text: loses provenance, mixes old instructions with the new objective, and grows recursively.
- Cascade ownership: deleting a service desk item must not delete independent construction work.

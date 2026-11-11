---
name: add-resource-kind
description: >-
  Checklist for introducing a new resource kind (definition or runtime) in the software-factory project, e.g.
  Conversation, User, Role, Squad, ToolServer. Covers model types, kind registry, namespace scope, admission,
  validator, schema, glossary and ADR.
---

# Add a resource kind (ADR-0002, ADR-0011)

## 0. Decide (an ADR is needed if any answer is new)
- **Scope:** `definition` (Git, read-only at runtime, namespace `factory-system` or a squad's namespace) or `runtime` (DB).
- **Who writes `spec`** (humans, sync, controllers creating children) and **who writes `status`** (exactly one controller).
- **Ownership:** which kind owns it (`ownerReferences` → cascade delete)?
- **Refs:** which `*Ref` fields does it have, and which kinds do they point to?
- **MVP?** If it isn't needed by the current §4 item, add a seam at most (rule 13).

## 1. Model
- Add `XxxSpec`, `XxxStatus`, and `type Xxx = Resource<XxxSpec, XxxStatus>` to `web/src/core/model/kinds.ts`.
  Use `DocumentResource` for Markdown definitions.
- Ref fields use `Ref` (`{ name, namespace? }`) and names ending in `Ref` / `Refs`.

## 2. Registry
- Register a `KindInfo { kind, plural, scope, description }` in the composition root's kind registry.

## 3. Admission (only if needed)
- Defaults → `Mutator` (e.g. namespace, labels, refs inherited from Source/Squad).
- Invariants → `Validator` (required fields, ref existence, allowed transitions).

## 4. Validation tooling
- If the new ref field names aren't yet in `REF_KINDS` in `tools/validate.py`, add them.
- Add the kind to the `kind` enum in `schemas/common.schema.json`.
- Definition kinds: add the folder to the definition loader and to the layout in `AGENTS.md` §3.

## 5. Controllers (runtime kinds with behavior)
- Follow the `controller-pattern` skill. Exactly one controller owns `status`.

## 6. Docs
- Glossary entry (`docs/ai-dlc-glossary.md`), and the architecture entity diagram (Mermaid) if it's a core concept.
- Add the kind to the runtime/definition list in `AGENTS.md` §1.
- An ADR if steps 0–5 introduced a decision.

## 7. Verify
`cd web && npx tsc --noEmit`, the tests, and `.venv/bin/python tools/validate.py`.

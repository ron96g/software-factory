# web/src/core
- `model/resource.ts`: KRM envelope, `Ref {name, namespace?}`, `ObjectKey` requires namespace. Namespaces: `factory-system` (definitions), `default` (runtime) in MVP.
- `model/kinds.ts`: spec/status per kind. WorkItem phase is generic (New/Running/Blocked/AwaitingApproval/Done/Closed/Failed); position = `status.stage` + `status.step` + `status.round` (round increments on every stage (re-)entry; AgentRun name `<wi>-<stage>-<step>-r<round>`, Clarification/Approval `<wi>-<stage>-r<round>`).
- `ports/`: ISP-split interfaces via `ports/index.ts`; app use cases in `ports/app.ts` (all take `Principal`). `StoreError`/`isStoreError` are the only runtime exports besides type guards.
- Imports use explicit `.ts` extensions; erasable TS only (no enums / parameter properties) so `node --test` runs sources directly.
- Composition root `factory.ts` (`createFactory`) is the only place with concrete classes. Status owners: workitem, agentrun, clarification, approval, conversation controllers (`runtime/controllers/`).
- Executor chain: LLM (needs resolvable ModelProvider + only registered read-only tools) → skill handlers (classification, codebase-research) → simulated. Tools are context providers in MVP (ADR-0017).
- Transcripts stored outside resources (`transcripts/`), redacted (content+meta); errors redacted before status/events.
- Next.js side: `src/server/` (singleton + `handler()` with principal), `src/app/api/**` thin routes, `src/ui/` client components, SSE at `/api/watch`.
# web/src/core
- `model/resource.ts`: KRM envelope, `Ref {name, namespace?}`, `ObjectKey` requires namespace. Namespaces: `factory-system` (definitions), `default` (runtime) in MVP.
- `model/kinds.ts`: spec/status per kind. Runtime WorkItem phase is generic (New/Running/Blocked/AwaitingApproval/Done/Closed/Failed); workflow position = `status.stage` + `status.round` (round increments on stage re-entry; part of AgentRun idempotency key).
- `ports/`: ISP-split interfaces, re-exported via `ports/index.ts`. Store ports take `(kind, namespace, name)`. `StoreError` (codes NotFound/AlreadyExists/Conflict/ReadOnly/Invalid) is the only concrete class in ports.
- Connector capabilities detected via type guards `canFetch/canComment/canReadComments` (ports/integration.ts).
- Transcripts are NOT stored in resources; separate append-only store via ports/transcripts.ts; executors must record via `ExecutionContext.transcript`.
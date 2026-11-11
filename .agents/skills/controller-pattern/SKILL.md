---
name: controller-pattern
description: >-
  How to write a reconciling controller in the software-factory core: level-triggered, idempotent, conditions,
  idempotency keys with `round`, durable human-in-the-loop via Clarification/Approval, requeue/backoff, events.
  Use for WorkItem, AgentRun, Clarification, Approval, Outbox and SourceSync controllers.
---

# Controller pattern (ADR-0005, docs/patterns.md §2–3)

## Shape
A controller implements `Controller` (= `Reconciler` + `WatchMapper`) from `ports/runtime.ts`, and optionally `InitialKeys`.
Dependencies are injected as **narrow ports**: `ResourceReader`, `ResourceWriter` (to create children), `StatusWriter`,
`EventRecorder`, `Clock`, and lookups.

```ts
export function createXyzController(deps: {
  reader: ResourceReader; writer: ResourceWriter; status: StatusWriter;
  events: EventRecorder; clock: Clock;
}): Controller & InitialKeys {
  return {
    name: "xyz",
    watches: ["Xyz", "ChildKind"],
    keysFor: (e) => [keyOf(ownerOrSelf(e.object))],   // "namespace/name"
    initialKeys: async () => (await deps.reader.list("Xyz")).map(keyOf),
    async reconcile(key) {
      const obj = await deps.reader.get<Xyz>("Xyz", ns(key), name(key));
      if (!obj || isTerminal(obj)) return;             // gone or finished: nothing to do
      // 1. Observe current state (children, gates) …
      // 2. Decide the single next action based on the CURRENT state, not on the triggering event
      // 3. Act idempotently (create a child with a deterministic name; AlreadyExists = fine)
      // 4. Write status once (StatusWriter), with conditions + phase
    },
  };
}
```

## Rules
1. **Level-triggered:** never rely on *which* event triggered the reconcile. Re-read everything.
2. **One step per reconcile:** do one transition, write status, and return. The resulting watch event triggers the next step.
   This keeps every step observable and makes restarts trivial.
3. **Idempotency keys:** child names are deterministic, e.g. AgentRun `"<wi>-<stage>-<step>-r<round>"`.
   `status.round` is incremented on every stage (re-)entry (rejects, answered clarifications), so re-runs get new names.
   On `create`, treat `StoreError("AlreadyExists")` as success and continue with the existing object.
4. **Status ownership:** only the owning controller writes an object's `status`, through `StatusWriter`. Humans/sync write `spec`.
5. **Conflicts:** on `StoreError("Conflict")`, return `{ requeueAfterMs: 0 }`. Never merge blindly.
6. **Conditions + phase:** update `status.conditions[]` (`setCondition` helper: change `lastTransitionTime` only when the
   status flips) and derive a summary `phase`.
7. **Human in the loop:** never wait. Create a `Clarification` / `Approval` (owned by the WorkItem), set phase
   `Blocked` / `AwaitingApproval` plus `status.blockedBy`, and return. Watching that kind maps it back to the owner's key and resumes.
8. **Events:** record a `Normal` event for each transition and a `Warning` for failures (`EventRecorder`). Events are the UI timeline.
9. **Errors:** throw for unexpected errors. The manager requeues with exponential backoff. Use `requeueAfterMs` for
   timers (escalations), and store due dates in status (`nextCheckAt`), not in memory.
10. **Side effects outward** (Jira/GitHub) only through `Outbox` (rule 7).
11. **No long work inside reconcile.** Agent execution happens in the AgentRun controller, which also guards against
    running twice in-process (an in-flight set), and re-runs `Running` runs after a restart.

## Tests (node:test, in-memory store)
- Reconciling twice with no changes makes no additional writes (idempotency).
- A crash between create-child and status-write recovers correctly (the child already exists).
- A `resourceVersion` conflict leads to a requeue, not data loss.
- Block → answer → resume re-runs the stage with an incremented `round`.

# ADR-0075: The item page is composed from workflow capabilities

- **Status:** Accepted
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Builds on:** ADR-0074 (retire legacy code workflows), ADR-0018 (UI), ADR-0025 (UX increment)

## Context
The item page (`web/src/app/items/[name]/page.tsx`) renders a fixed list of panels. Most of them belong to the code
pipeline, but the page shows them on every item except retrospectives. Each panel then decides for itself whether it
applies, and each one decides differently:

| Panel | How it decides today |
|---|---|
| Verification contract | fetches `/verification`, hides itself unless `enabled` (since ADR-0074) |
| Check evidence | always shown; offers manual checks once the item is stopped |
| Unit progress | page checks `constructing`; the panel fetches `/units` and hides itself unless `enabled` |
| Planning workspace | page fetches `/planning`; `enabled` also collapses "Operational details" |
| Pull requests | page derives it from outbox messages |
| Jira ticket actions | needs `externalRef`, fetches `/tickets`, hides itself unless `enabled` |
| Retrospective | `item.spec.retrospective` |

This has three problems:
1. **Wrong by default.** A new panel shows on every item until someone remembers to hide it. A service desk item showed
   "Verification contract: Legacy workflow" with a button that restarted the ticket into the code pipeline (ADR-0074).
   It still shows "Check evidence" with a manual check that builds an unchanged checkout. Nothing in the service desk
   workflow ever creates checks.
2. **Scattered and costly.** Whether a panel applies is answered in several places, often by a network request that
   exists only to return `enabled: false`.
3. **Doesn't scale with workflows.** Each new workflow (support, operations in v0.6, squad workflows in v0.4) would
   need more special cases. A check on the workflow name would break rule 4 (registries, not `switch`).

What a page should show already follows from the definitions. The compiled workflow knows if it has a verification
policy, planning, Unit execution, check gates, publishing stages or ticket publication. The item and its Source know
if it is synced and whether the Source allows write-back.

## Decision
1. **Item capabilities.** The core derives a set of named capabilities per work item, e.g. `planning`,
   `verification`, `checks`, `unit-execution`, `pull-requests`, `ticket-actions`, `retrospective`.
   - Each capability comes from a `CapabilityDetector` (`web/src/core/ports/capabilities.ts`) registered by name in
     the composition root (rule 4). It is a pure function of the compiled workflow, the item, its Source and the
     item's runs, CheckRuns and outbox messages. The built-ins are in `web/src/core/capabilities/detectors.ts`; a
     feature added later registers its own detector. The core never checks workflow names.
   - **Declared or used.** A capability is present if the workflow declares it **or** the item already has
     resources of that kind (CheckRuns, pull-request outbox messages, units, …). History never disappears, even after a
     workflow change or a restart into another workflow.
   - `WorkItemDetail` gets `capabilities: string[]`, computed with the detail. That is one source of truth for API,
     UI and MCP (ADR-0034).
2. **Panel registry in the UI.** The item page renders panels from a registry (`web/src/ui/item-panels.tsx`). Each
   entry has `id`, `region` (`summary` · `attention` · `primary` · `operational`), `order`, `requires` (one or more
   capabilities) and the component. The page groups entries by region and renders those whose capabilities are
   present. A panel is mounted only with its capabilities, so items without them make no requests for it. A panel
   may still return nothing when there is nothing *current* to show (no pull request yet, or a capability that is
   only "used" and whose endpoint reports nothing current); its own `enabled` check stays as that safety net.
3. **Workflow-neutral panels stay unconditional:** header, stage chips, clarifications, approvals, context, artifacts,
   agent runs, description, ticket history, human input, timeline, issues, feedback and chat.
4. **No presentation in definitions.** Workflows don't list panels. A workflow gets a panel by declaring the feature the
   panel shows. If service desk ever needs checks (e.g. "does this test fail on main?" before confirming a bug), it
   declares a check gate or a check-capable step and the panel appears.
5. **Mapping at introduction:**

   | Capability | Present when | Panels |
   |---|---|---|
   | `planning` | `workflow.planning` | Planning workspace (collapses operational details) |
   | `verification` | `workflow.verification` | Verification contract |
   | `checks` | `workflow.verification`, a stage gate with named `checks`, or CheckRuns owned by the item | Check evidence |
   | `unit-execution` | `workflow.unitExecution`, or an AgentRun assigned to a Unit | Unit progress (from construction on) |
   | `pull-requests` | a stage with `publish.pullRequest`, or pull-request outbox messages | Pull requests |
   | `ticket-actions` | `externalRef` and a Source with reviewed write-back (ADR-0040), or ticket outbox messages | Jira ticket actions |
   | `retrospective` | `item.spec.retrospective` | Retrospective panel (`factory-retrospective` declares no code features, so no code-pipeline panel applies) |

   For a service desk item this leaves ticket actions plus the neutral panels. A `factory-plan` item keeps all panels.

## Rollout
1. **Capabilities in the detail.** Detector port, built-in detectors, `WorkItemDetail.capabilities`, tests per
   detector including "used but not declared". The Check evidence panel requires `checks`, which closes the service
   desk gap with the smallest change.
2. **Panel registry.** Move every workflow-specific panel onto the registry. A panel is mounted only with its
   capabilities, so an item without it makes no request for it; the planning workspace is only fetched for `planning`
   items.
   Page structure and order stay the same for `factory-plan` items. Acceptance: the capabilities of a
   `factory-plan`, a manual and a synced `servicedesk` item, and the detector cases (including retrospectives).
3. **Later (not part of this ADR):** focused layouts per region set (e.g. a reply-centred service desk page) can build
   on the same capabilities without new rules.

## Consequences
- A new workflow gets the right page by declaring features; a new panel declares what it needs. Panels are hidden by
  default for a workflow that doesn't need them instead of shown by default.
- Fewer requests per page load: verification, units, tickets and planning are only requested for items with the
  capability.
- A few page-level special cases stay outside the registry: the header's pull-request links, collapsing operational
  details and hiding the context card when planning shows them, and the plan approval living in the planning workspace.
- MCP and API clients can tell what an item supports without guessing from workflow names.
- Detectors must be kept honest. A capability whose detector forgets a gate type hides a panel that a human needs.
  "Declared or used" limits the damage to items that haven't used the feature yet; tests cover each detector.
- AGENTS.md: row X55. Glossary: **Item capability**. Architecture: "Dashboard (UI)".

## Alternatives considered
- **Hide panels by workflow name** (e.g. `workflow !== "servicedesk"`). Smallest change, but violates rule 4 and
  breaks with every new or renamed workflow.
- **List panels in the Workflow definition** (`spec.ui.panels`). Explicit, but puts presentation into definitions,
  duplicates what the workflow's features already say, and drifts when panels change.
- **Keep self-hiding panels and fix each one.** Works for the check panel today, but keeps decisions scattered,
  keeps the probe requests and keeps "shown by default".
- **Per-workflow page layouts.** Gives the most focused pages, but each workflow would need its own page. Capabilities
  plus regions get most of the benefit; dedicated layouts can follow later on top of them.

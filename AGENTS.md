# AGENTS.md

Binding instructions for **every** agent (AI or human) working in this repository.
Read this file completely before you change anything.

> **The plan below is binding.** It can change, but only through an ADR (see "Changing the plan").
> If a task conflicts with this file or an accepted ADR, stop and propose an ADR first. Don't silently diverge.

---

## 1. What we are building

A **software factory** that implements the **AI-DLC** (AI-Driven Development Lifecycle) *as code*:

- **Definitions as code** (in Git): `Agent` and `Skill` as Markdown with YAML frontmatter; `Workflow`, `ArtifactType`,
  `Source`, `Repository`, `ModelProvider`, `KnowledgeSource`, and `ToolServer` as Kubernetes-style custom resources
  (YAML). They reference each other through typed `*Ref`s.
- **Runtime** (in a DB): `WorkItem`, `AgentRun`, `Artifact`, `Clarification`, `Approval`, `Conversation`, `Event`,
  `OutboxMessage`, `KnowledgeEntry` (ADR-0030), `RetrospectiveFeedback` (ADR-0041), `CheckRun` (ADR-0042), and `InlineFeedback` (ADR-0071), all modeled as custom resources (`apiVersion / kind / metadata / spec / status`). Agent
  **transcripts** are stored separately in an append-only log (ADR-0012).
- **Factory loop** (diagram: `docs/ai-dlc-glossary.md`):
  input (manual | Jira | GitHub | monitoring) → classify → triage → spec → spec-review [human] → implement →
  code-review [human] → verify → ship (draft PR) [human]; monitor → repeat returns with v0.6 (ADR-0065)
- **UI:** a dashboard (table) of WorkItems. You can create items manually, sync them from sources, answer clarifications
  (which unblocks items), and approve or reject gates.
- **code-researcher:** a shared, read-only agent that any agent (mainly the triager and the SRE) can delegate to.
  It researches the `Repository` code and writes `research-notes` into the WorkItem.

Required reading:
`docs/ai-dlc-glossary.md` (vocabulary), `docs/architecture.md` (entities, lifecycle, UI), `docs/patterns.md` (patterns),
`docs/security.md` (threat model, trust boundaries, findings `SEC-n`, accepted risks), `docs/adr/` (decisions).

---

## 2. Non-negotiable rules

1. **Interface first.** Define or extend a port (interface) in `web/src/core/ports/` *before* writing an implementation.
   Implementations depend on ports, never on other implementations.
2. **Interface Segregation Principle.** Interfaces stay small and role-specific (e.g. `ResourceReader` vs `StatusWriter`,
   `ItemFetcher` vs `CommentPublisher`). Never add a method to an interface just because one implementation needs it.
   Add a new interface instead.
3. **Ports & Adapters.** `web/src/core/` never imports Next.js, React, or concrete adapters. Wiring happens **only** in the
   composition root (`web/src/core/factory.ts` or equivalent).
4. **Extend through registries, not edits.** New source types, gate types, checks, skill handlers, context providers,
   executors, and kinds are added by *registering* an implementation. Core logic must not grow `switch (type)` blocks.
5. **Resource model everywhere.** Every persisted object is a KRM-style resource. Humans and sync write `spec`, and only
   controllers write `status` (through the `StatusWriter` port). Writes use optimistic concurrency (`resourceVersion`).
6. **Controllers reconcile.** They are level-triggered and idempotent. Side effects use deterministic idempotency keys.
   Never wait for a human inside a process. Use durable suspension (`Clarification` / `Approval` resources).
7. **Outbound effects go through the outbox** (e.g. comments to Jira or GitHub), never directly from a controller.
8. **Human in the loop.** AI proposes and humans approve. Never remove or bypass a `human-approval` gate without an ADR.
   Gate decisions happen only on a surface a sandbox cannot reach, through an authenticated principal, with an origin
   check on state-changing routes: the decide/review/publish routes belong to the UI listener, never to the runtime-facing
   one (`SEC-15`/`SEC-16` in `docs/security.md`).
9. **Auth-ready.** Auth is not implemented yet (increment v0.4, ADR-0009), but code must not make it harder:
   - Every API entry point must be easy to wrap with a `Principal` (no global "current user" shortcuts).
   - Every resource carries `metadata.namespace` (ADR-0011). Store keys are `(namespace, kind, name)`. Don't introduce
     queries that can't be scoped by namespace, label, or field selectors.
10. **Keep definitions valid.** Run `python tools/validate.py` (or its TypeScript successor) after changing
    `agents/`, `skills/`, `workflows/`, `artifacts/`, `sources/`, or `repositories/`. Broken refs are build failures.
11. **Vocabulary.** Use the terms in `docs/ai-dlc-glossary.md`. Add new terms there.
12. **Comments** are sparse and explain *why*, not *what*.
13. **MVP first (ADR-0010).** Only build what the current item in §4 requires. If you're tempted to build ahead, add a
    seam (an interface or optional field) at most, and note it in the PR or summary.
14. **Everything an agent does is recorded (ADR-0012).** Every LLM call, tool call, and delegation goes through the
    `TranscriptRecorder` in the `ExecutionContext`. An unrecorded interaction is a bug. Transcripts are append-only, and
    secrets are redacted. Follow-up "explain" conversations are side-effect free.
15. **All diagrams are Mermaid (ADR-0013).** Use fenced `mermaid` blocks in Markdown (flowchart, stateDiagram-v2,
    sequenceDiagram, classDiagram, erDiagram, …). Don't use ASCII or box-drawing art. Directory trees and inline
    `a → b → c` sequences in prose are not diagrams. The same applies to diagrams that agents generate (e.g. a DDD
    domain model).
16. **Secrets are referenced, never stored (ADR-0015).** Only `secretRef: { name }` appears in resources. Values come from
    `SecretResolver`, are redacted everywhere, and are never put into prompts.
17. **Providers via tiers (ADR-0014, ADR-0028).** Agents declare `model.tier`, never a vendor or model name; per-agent
    models are mapped on the `ModelProvider` (`agentModels`). Providers are
    `ModelProvider` definitions resolved through `ModelResolver`.
18. **No free-form execution on the host (ADR-0016, ADR-0019, ADR-0022).** Shell, file writes, and code execution only run inside an
    `ExecutionEnvironment` sandbox (read/search of the workspace doesn't need one). Without a sandbox runtime, such agents fall back to simulation with a visible reason, or wait for one
    with `FACTORY_SIMULATION=wait` (ADR-0029). Isolation is a floor, not a choice: there is no execution without a
    primitive. The unsandboxed `host` runtime was removed (ADR-0080 §10) — `FACTORY_SANDBOX_RUNTIME=host` fails loudly
    and its code survives only as a test helper. The OpenCode agent runtime (ADR-0060, ADR-0079) writes and executes on
    the `bwrap` (filesystem-isolated) runtime, with deny-by-default permissions and a scrubbed command environment.
    ADR-0080 extends this to the whole runtime: an `AgentRuntime` hosts the agent loop, the workspace and the
    toolchain; the factory executes no workload code and reads no workload-controlled configuration (git config, hooks,
    filters, package scripts), exposes only a model proxy, a scoped tool surface and a run job API, treats agent output as
    data, and produces evidence in runtimes the candidate cannot influence. The isolation waiver lives in the reviewed
    profile (`spec.acceptWeakerIsolation` — never an environment variable), and spawning a host process is a property of a
    `ToolServer` definition (`spec.hostExecution`) instead of a consequence of the selected runtime.

---

## 3. Repository layout

```
AGENTS.md            this file (binding)
agents/ skills/      Agent & Skill definitions (Markdown + frontmatter)
workflows/           Workflow CRs
artifacts/           ArtifactType CRs
sources/             Source CRs (manual, github, jira, monitoring-feedback)
repositories/        Repository CRs (codebases agents research/edit)
knowledge-sources/   KnowledgeSource CRs (external docs agents can search, ADR-0030)
tool-servers/        ToolServer CRs (MCP servers agents may use, ADR-0034)
components/kubernetes-cr-mcp/  Standalone read-only Kubernetes CR MCP server (ADR-0035)
schemas/             JSON Schemas
tools/               validate.py
examples/            example runtime objects
docs/                glossary, architecture, patterns
docs/adr/            Architecture Decision Records (NNNN-title.md)
web/                 Next.js app
  src/core/model/    resource + kind types (pure types)
  src/core/ports/    interfaces (ISP)
  src/core/…         implementations (store, admission, runtime, workflow, agents, adapters)
  src/app/           Next.js UI + API (adapter on top of core)
```

---

## 4. Plan: MVP first, then increments (ADR-0010)

The status column must be kept up to date. Mark an item ✅ only when its exit criteria hold.
**Build only what the current increment needs.** Add a seam for later only when retrofitting it would be expensive.

### Foundation (done)
| # | Item | Exit criteria | Status |
|---|---|---|---|
| F0 | Concepts & definitions: glossary, loop, agents, skills, workflows, sources, repos, validator | `validate.py` passes | ✅ |
| F1 | Ports in `web/src/core/ports` (namespace seams per ADR-0011) | `tsc` passes, reviewed | ✅ |

### MVP (v0.1): Inception done for real
Goal: manual or GitHub input → classify → triage + code research → clarification (block/answer/resume) → spec + units →
human spec-review → **Ready for construction**. Later stages run on the simulated executor.

| # | Item | Scope | Exit criteria | Status |
|---|---|---|---|---|
| M1 | Store & admission | SQLite (`node:sqlite`), Git definition loader, composite store, admission (Source defaults, ref validation), Event recorder, **append-only transcript store** (ADR-0012). Namespaces `default` / `factory-system` only | CRUD, `resourceVersion` conflicts, owner cascade, transcript append/read tested | ✅ |
| M2 | Control plane | Work queue, controller manager, WorkItem / AgentRun / Clarification / Approval controllers, workflow compiler, `decision` + `human-approval` gates (`automated` passes) | An item flows to Done on the simulated executor, including block/answer and approve/reject | ✅ |
| M3 | Agent pipeline | Context factory, prompt builder, executor chain (LLM → skill handlers → simulated), **`ModelProvider` kind + `ModelResolver` + OpenAI-compatible & Anthropic adapters** (ADR-0014; `ToolCallingLLM` port only, loop in v0.5 per ADR-0017), **env `SecretResolver` + redaction** (ADR-0015), **read-only tool registry** (ADR-0016), code-search context provider (ripgrep on local-path repos), **transcript recording + provenance**, **explain-mode `ConversationResponder`** | Triage attaches `research-notes` with `repo:path:line` citations; every run has a transcript; "why?" gets an answer grounded in that transcript | ✅ |
| M4 | Sources | `manual` + GitHub `ItemFetcher`, "Sync now" | GitHub issues appear as WorkItems | ✅ |
| M5 | UI | Next.js + Mantine (clean light/dark theme, ADR-0018): dashboard table, new item, sync, item detail (stages, artifacts, timeline), answer clarification, approve/reject, **run timeline + transcript viewer (incl. delegation tree, provenance) + "Ask this agent" chat**, Markdown with **Mermaid rendering** (ADR-0013), live updates (SSE) | MVP goal demonstrable end to end | ✅ |

### Increments after the MVP (re-planned when each one starts)

#### v0.2: Write-back (current)
| # | Item | Scope | Exit criteria | Status |
|---|---|---|---|---|
| W1 | Outbox | `Outbox` port impl (writes `OutboxMessage`), outbox controller delivers through `OutboxHandler` registry with exponential backoff; WorkItem controller enqueues the clarification questions when the source is `bidirectional` | Questions of a blocked synced item are delivered exactly once (idempotent name), retried on failure | ✅ |
| W2 | GitHub write/read | `CommentPublisher` + `CommentReader` on the GitHub connector; echo suppression via a hidden marker | Comment posted; replies read back | ✅ |
| W3 | Answers from comments | Clarification sync controller polls `CommentReader` for open clarifications on synced items; a human reply becomes the answer (the item resumes) | Replying on the issue unblocks the item | ✅ |
| W4 | Jira connector | `ItemFetcher` + `CommentPublisher` + `CommentReader` (REST v3, basic auth email+token) | Same tests as GitHub with a fake API | ✅ |
| W5 | Re-run replay | `RunReplayer`: new AgentRun from a run's spec (labelled replay, never advances the workflow, its artifacts are not used as inputs), UI "Re-run" + side-by-side compare | Re-run result visible next to the original; workflow state unchanged | ✅ |

Known v0.2 simplifications: all replies found at the first poll become one answer (later replies are ignored); replies
older than the Clarification are ignored (clock skew can drop a very early reply); the factory's marker is visible as
text in Jira comments.

#### v0.3: Construction for real (current, re-planned per ADR-0019)
| # | Item | Scope | Exit criteria | Status |
|---|---|---|---|---|
| S1 | Sandbox ports & profile | `ExecutionEnvironment` + segregated `Sandbox*` ports, `SandboxHealth`, `SandboxProfile` kind, `sandboxRef` on agents/repos, in-memory fake sandbox for tests | Ports reviewed; fake passes a contract test | ✅ |
| S2 | Runtime selection & `none` | Registry + `auto` selection by health and minimum isolation, `none` adapter, provenance + UI health badge, explicit fallback reason | Without a runtime: analysis works; construction is simulated with a visible reason | ✅ |
| S3 | Tool-call loop | `ToolCallingLLM` adapters, agent tool loop (recorded), sandbox-bound tools (`run`, `read_file`, `write_file`, `git_diff`) | Developer agent edits code and runs tests in the fake sandbox | ✅ |
| S4 | First real adapter | `host` (ADR-0020, explicit opt-in, unsandboxed, per-item Git worktree; removed, ADR-0080 §10); container/kubernetes adapters later | Real run on the dev machine | ✅ host (since removed, X61) · ☐ isolated adapters |
| S5a | Workspace resource (ADR-0021) | `Workspace` kind + controller, `WorkspacePreparer`/`WorkspaceCleaner` ports, host worktree adapter, setup commands, items wait for Ready, code search + sandboxes use the workspace, provenance `repo@commit` | All agents of an item see the same pinned code state; workspace visible + cleaned up | ✅ |
| S5b | Read-only code tools for analysis agents | `read_file`/`list_files`/`search_code` on the workspace for triager, architect, reviewer | Reviewer reads surrounding code, not only the diff | ✅ |
| S5c | Real checks + draft PR | `build`/`unit-tests` gate checks in the workspace, push branch + draft PR through the outbox | End-to-end PR from a work item | ✅ (draft PR #1 opened by the factory) |
| U1 | Navigation | Left navbar with entities (work items, definitions, workspaces); generic resource list/detail views | Every kind browsable from the UI | ✅ |
| Q1 | Review → fix loop | Stage-level `loop` (outcome → goto, bounded): AI code review returns `changes-requested` for blocking findings, the developer gets the review as input and fixes before the human gate | Blocking AI findings are fixed automatically (max N rounds), then humans review | ✅ (ADR-0024) |
| Q2 | Visible control-loop errors | `ReconcileErrorReporter` port: repeated reconcile failures become Warning events on the object; failing-controller count in system health + UI badge | A stuck item shows why in its timeline | ✅ (ADR-0024) |

Known v0.3 limits: the advisory check path (failed check output not fed to the developer, checks re-run after a restart, advisory verifier verdict) applied to the retired `factory-loop`; `factory-plan` uses the verification contract instead (ADR-0042, ADR-0074). Workspaces fork from the **committed** HEAD (uncommitted local changes are invisible to agents); only `host` has a workspace backend so far; tool results go to the model unredacted, which is safe
only because sandboxes never receive factory secrets (ADR-0019 §7).

#### UX increment (current, replaces v0.4 for now — ADR-0025)
| # | Item | Scope | Exit criteria | Status |
|---|---|---|---|---|
| X1 | Readable Markdown | GFM (tables, task lists, strikethrough, autolinks), styled tables/code/headings, consistent renderer everywhere (artifacts, transcripts, chat, PR-ready content) | Agent tables render as tables in light and dark mode | ✅ |
| X2 | Usable timeline | Fixed-height scrollable (sticky) timeline, filter (key events / all / warnings), compact entries | Long items keep the page short; key events findable at a glance | ✅ |
| X3 | Structured agent runs | Runs grouped by stage (workflow order) → rounds (latest open, older superseded) → step rows (agent, outcome, duration, executor, summary); replays nested | The current state and history of runs are understandable without opening transcripts | ✅ |
| X4 | Ask about the work item | `Conversation.purpose` (`explain` run · `explain-item` whole item), responders registered by purpose, item responder grounded in all runs/artifacts/human input/events; "Ask about this item" chat | "What did the product owner do?" answered without opening the PO run | ✅ (ADR-0026) |
| X5 | Clear gates | Structured verdicts (`StepSpec.outcomes`, verifier `pass/partial/fail`), gate evidence (ok/warning/blocking) at every gate, server-enforced override with reason when blocking, verdict badges on artifacts + stage chips (ADR-0027) | A failed verification can't be approved by accident; the reason is visible at the gate | ✅ |
| X6 | Structured clarifications | Header with asking agent + why + progress, one card per question (Markdown, own answer, skip), positional answers, "Ask the agent about these questions" chat | Answering several questions is calm and clear; users can ask back before answering | ✅ |
| X7 | Gate decisions steer agents | Decided approvals (decision + comment) are agent input ("Human gate decision"); "Approve & let agents decide" delegates open decisions to recommended defaults (documented, no re-asking); reject reasons reach the re-run | A human can delegate open decisions in one click; rejection feedback is acted on | ✅ |
| X8 | Per-agent models | `ModelProvider.agentModels` (agent → model) overrides the tier for that agent (ADR-0028) | Different agents run on different models without naming vendors in agent files | ✅ |
| X9 | Sync from real sources | GitHub source points at `ron96g/software-factory` (label `factory`); dashboard "Sync" imports issues | Labelled issues appear as work items | ✅ |
| X10 | Restart & simulation policy | `spec.restart` (from the first or a chosen stage, new round, earlier output superseded), UI "Restart" menu; `FACTORY_SIMULATION=wait` keeps runs Pending until a real executor fits (ADR-0029) | An item processed without an LLM can be re-run with one, history kept; with `wait`, no placeholders are produced | ✅ |
| X11 | Service desk workflow | `servicedesk` workflow + `support-engineer` agent + `support-analysis`/`customer-response` artifacts; `jira-servicedesk` uses it with repository `controlplane` | A request is investigated against the code and produces a human-reviewed reply; automatic sync stays read-only (reviewed publication extends this in X21) | ✅ |
| X12 | Knowledge base | `KnowledgeEntry` (agents propose via the `knowledge-base` skill → human approves, edits, or refines with the proposing agent), `KnowledgeSource` (`files`: ripgrep over local docs), `KnowledgeSearcher` context + `search_knowledge` tool, UI "Knowledge" (ADR-0030) | An agent's proposal is approved by a human and then used (cited) by a later run; unapproved knowledge never reaches agents | ✅ |
| X13 | Wait on model quota | HTTP 429/503/529 → `ModelUnavailableError`; the run waits (`retryAt`, Retry-After or backoff up to 15 min) instead of failing the item; the item shows phase `Waiting` with the reason (ADR-0031) | An exhausted quota pauses the item visibly and it resumes by itself | ✅ |
| X14 | Additional context | `WorkItem.spec.context` (human-only, sync never overwrites) in every agent prompt; editable in the new-item form and on the item page (ADR-0032) | Agents use team-provided context without asking for it | ✅ |
| X15 | Toolchains in sandboxes | `SandboxProfile.env` (plain, non-secret), repository's profile wins over the agent's, `go-build` sets `GOPROXY`; developer/verifier install tools themselves (ADR-0033) | An agent installs `controller-gen`/envtest itself on a Go repo | ✅ |
| X16 | MCP | Factory as MCP server (`/api/mcp`, bearer `FACTORY_MCP_TOKEN`, no gate tools) + `ToolServer` kind / `ToolProvider` port for agents (http; stdio with `spec.hostExecution`); `support-engineer` uses the factory's own MCP for knowledge (ADR-0034) | A local harness creates and answers items via MCP; an agent calls an MCP tool in its run (recorded) | ✅ |
| X17 | Kubernetes CR MCP | Standalone stdio server with YAML-allowlisted CR types, namespaces and reference hierarchy; discovery, label-filtered list, get and bounded hierarchy; support engineer integration (ADR-0035) | Standalone protocol/API tests pass; agent integration uses existing MCP recording; no cluster writes or credential exposure | ✅ |
| X18 | Direct agent chat | Standalone `agent-chat` Conversations, explicit read-only MCP policy and answer completion, durable serialized turns and waiting/error states, resumable UI, human conversion to WorkItem (ADR-0036, ADR-0038) | Support engineer investigates via recorded tools without a WorkItem; announcements cannot end a turn; restart/retry preserves messages; conversion preserves human gates | ✅ |
| X19 | Work-item agent chat | Optional `workItemRef` on direct chats, shared bounded evidence digest refreshed and recorded per turn, start/resume from item or Chats (ADR-0037) | Agent uses item evidence plus allowed MCP reads; new turns see updated context; workflow and gates remain unchanged | ✅ |
| X20 | Work-item follow-ups | Human-created independent items with selected workflow/repositories, reviewed evidence snapshot and separate free-text instructions (ADR-0039) | Preview is bounded and stale-safe; retries deduplicate; new agents see instructions and evidence; origin, gates and deletion lifecycle stay independent | ✅ |
| X21 | Reviewed Jira actions | Fresh publication review after response review, explicit public/internal replies, optional follow-on or standalone Jira transitions through the outbox (ADR-0040); automatic service-desk sync remains read-only | Exact response/visibility reviewed; live allowed transitions; durable receipts and safe crash recovery; existing completed items never post automatically | ✅ |
| X22 | Agent retrospectives | Workflow feedback with pinned provenance, deterministic support thresholds, separate proposal-only retrospective workflow, human review and manual implementation follow-up (ADR-0041) | Deduplicated eligible support creates one investigation; evidence survives origin deletion; human review is durable; originating workflows and publication permissions stay unchanged | ✅ |
| X23a | Reliable check execution | Structured CheckRun lifecycle/outcomes, configurable per-check budgets, durable redacted logs/results and evidence UI (ADR-0042) | Check identity and tested snapshot are pinned; interrupted execution recovers; results deduplicate and survive restart; missing evidence is never a pass | ✅ |
| X23b | Evidence-driven recovery | Typed failure routing, separate execution/code retry budgets, durable human attention and developer check-failure input (ADR-0042; after X23a) | Timeout, cancellation and setup failure do not trigger blind code-edit loops; repeated unchanged failures escalate with actionable evidence | ✅ |
| X23c | Verification contracts | Reviewed validation plans, same-environment preflight, shared agent/gate check runner, snapshot freshness and required-evidence enforcement (ADR-0042; after X23b) | Required evidence or explicit policy-permitted waivers are bound to plan/candidate; stale or simulated evidence cannot pass; existing gates and publication permissions remain intact | ✅ |
| X24 | Candidate preparation and recovery | Pre-review named preparation checks, active-job waits, bounded return-to-review on drift and explicit check selectors (ADR-0043) | Builds cannot race review; regenerated code gets fresh review; clarification answers cannot impersonate approval; preparation never replaces verification | ✅ |
| X25 | Affected-module verification | Repository dependency graph selects changed modules and transitive dependents for named build/test checks across preparation, agents, gates and manual execution (ADR-0044) | Immutable scope provenance; committed and dirty changes covered; shared/unknown changes use explicit full scope; plans and human approvals remain revision-bound | ✅ |
| X26 | Plan-first workspace | Opt-in research-backed editable plan, consolidated directly answerable human decisions and exact-revision review (ADR-0045, ADR-0046) | Human edits/answers regenerate a reviewed proposal without manual unlocking; no automatic clarification interview; stale or unresolved plans cannot authorize construction; existing gates remain intact | ✅ |
| X27 | Complete Units before review | Sequential execution of approved Units with durable progress, evidence and a pre-review completeness barrier (ADR-0047) | All required Units have current readiness evidence before any code review; blocked work stops visibly; existing review, verification and publication safeguards remain intact | ✅ |
| X28 | Human decides over AI plan review | Unresolved AI plan review findings are advisory; approving over them needs an explicit reason (ADR-0048) | A disagreeing AI reviewer cannot leave an item stuck; all other planning and verification guards stay enforced | ✅ |
| X29 | Simpler loop, focused item page | Malformed agent output is rejected at its producing step and only that step reruns with the reason; item page shows pending decisions first, then the current phase, details collapsed (ADR-0049) | Format mistakes never stop an item after the full planning chain; no disabled controls or other-phase panels on the item page | ✅ |
| X30 | One planner run, revocable answers | `factory-plan`: one planner run produces spec, Units, validation and implementation plan; one independent review; humans can withdraw stale answers (ADR-0050) | A revision costs one planner run plus one review; withdrawn answers stop steering agents; existing `factory-planned` items continue unchanged unless explicitly migrated | ✅ |
| X31 | Focused plan, approved design | `factory-plan`'s implementation plan becomes a decision sheet (risks + decisions only, sources shown alongside); the architect's design adds a logical design and a tech lead approves it at a new gate (ADR-0051) | The plan no longer restates spec, Units or validation; code is only written after a human approved the design; full-format workflows unchanged | ✅ |
| X32 | Model usage and cost accounting | Provider-reported per-call token usage persisted in transcripts, with run/WorkItem rollups and optional versioned provider-price estimates (ADR-0052) | Every model call is attributable and durable; retries, delegated runs and replays are counted without double-counting; Copilot reporting is verified or marked unsupported; missing usage and estimates are explicitly labeled; historical usage is not fabricated | In progress (per-call usage recorded on the tool-loop path; rolled up by the X62 metrics read model; price estimates optional and operator-provided; OpenCode usage where the SDK reports it) |
| X33 | Base-branch conflicts | PR publication detects conflicts with the moved remote base (no push), publish stages wait for PR delivery, the Workspace merges the new base (markers, re-pinned base), bounded `onConflict` back to implement, then human clarification (ADR-0053) | Parallel items never open an unmergeable PR; the developer resolves markers and the result is reviewed and verified again; exhaustion asks a human | ✅ |
| X34 | Keep published PRs mergeable | "Update pull request" re-publishes from the publish stage (ADR-0053 resolution, same branch and PR), on-demand conflict status of published PRs; a plan approval made stale only by workflow/repository definition changes is re-confirmed in place as an Approval, not an unanswerable clarification (ADR-0054) | A conflicting published PR is updated without restarting planning; existing evidence stays bound to the approved plan; changed specs or plans still need full plan review | ✅ |
| X35 | Typed planning reviews | Schema-backed ArtifactType contracts, typed review findings and answerable decision references, contract-bound approval and explicit readiness (ADR-0055) | Invalid output cannot advance; human questions are answerable; stale contracts cannot authorize approval; advisory findings remain human-overridable; historical reports stay readable | ✅ |
| X36 | Owner-led peer feedback | Proposed: one WorkItem owner, revision-bound peer threads, owner accept/reject and durable accepted input for plan/design revisions; trusted identity and scoped authorization required before multi-user enablement (ADR-0056) | Peers discuss early; only the owner accepts guidance; the next relevant run records it; stale/concurrent decisions cannot bypass existing plan/design review, verification or publication gates | Proposed |
| X37 | Accessible tools, grounded reviews | Cited code resolved into context before the first step, harness-rendered tool guide, citable read tools, output validated in-loop at `finish`, code evidence and investigated research gaps in `planning-review` v2, tool-use provenance (ADR-0057) | Cited claims are visible to agents without tool calls; output mistakes are corrected in the same run, reruns stay the exception; research gaps show what was checked; agent definitions unchanged | ✅ |
| X38 | Graceful step budget | Budget stated in the tool guide, recorded wrap-up warnings near the end, a finish-only last step whose result is marked and reviewed normally (ADR-0058) | A run out of budget reports its work instead of failing the item; runs that never finish still fail | ✅ |
| X39 | Autonomous technical recovery | Retained completed-attempt evidence, schema-backed diagnostics, bounded evidence-driven recovery and harness-offered scoped readiness checks (ADR-0059); production diagnostic isolation and authenticated operator allocation remain unavailable | Routine technical failures recover without human questions; unchanged failures cannot loop indefinitely; genuine human-only needs are consolidated; completeness, approvals and publication guards remain intact | In progress |
| X40 | OpenCode agent runtime | Embedded OpenCode v2 (`@opencode/sdk`) runs every LLM AgentRun: factory-controlled models only, deny-by-default permissions from agent tools, repository skills and sub-agents, factory tools and ToolServers as plugin tools, in-loop `finish` validation, step budget and wrap-up, quota waits, full transcript; `FACTORY_AGENT_RUNTIME=tool-loop` opts out; isolated sandboxes fall back to the tool loop until a workspace driver exists (ADR-0060) | An item runs end to end on OpenCode with every step recorded; read-only agents cannot write; commands never see factory secrets; the tool loop is removed once parity is shown on real items | In progress |
| X41 | Verification tiers, side-effect-free checks | (a) tiers set check scope (`readiness`: changed, `preparation`/`verification`: affected, `publication`: full), evidence identity includes the tier, `minScope`, legacy `moduleScoped` unchanged; (b) no check may modify the candidate, writing checks run on isolated candidate copies; (c) declared caches, result caches partitioned per item and tier, never reused by verification; (d) publication tier (ADR-0061) | Per-Unit readiness runs only changed modules; narrower evidence can never satisfy a gate; a readiness run cannot seed verification results | In progress (a ✅; b partly: a check that modifies the candidate is detected for **every** outcome and the candidate is restored, `WorkspaceCheckpoint` — ADR-0061 §2; isolated candidate copies still pending) |
| X42 | Check worker | (a) store-backed change feed for all controllers and SSE; (b) store-backed workspace lock; (c) separate check worker with fenced CheckRun leases, reaper, concurrency limits (ADR-0062) | A web restart doesn't interrupt checks; a stale worker can't write results; agent mutations and checks never overlap across processes | ✅ (X42a change feed; X42b fenced workspace lock; X42c claims + fenced status writes + reaper-on-expiry + worker process/two composition roots (`FACTORY_ROLE`) + feed-driven controllers/SSE + lease renewal + concurrency limits + live-worker health + incarnation release + worker-older-definitions. Caveat: the incarnation release needs a real process-group killer to be active — the default kills nothing, so stale locks wait for their TTL) |
| X43 | Evidence before the verifier | Entering the verify stage collects the plan's checks before the verifier runs; the verifier evaluates them (no `run_check`); the gate only confirms (ADR-0063) | The verification report describes the evidence the human approves; no authoritative check runs twice because an agent ended | ✅ |
| X44 | Check definition version | Plans and check evidence bind to the repository's check definition (`local`, `workspace`, `sandboxRef`, `checks`, `moduleScope`, `verification`), not the whole Repository; a stale preflight is rerun in place before publication (ADR-0064) | Adding `git:` to a repository in flight needs no plan re-confirmation and no new checks | ✅ |
| X45 | Ship publishes only | `ship` has no agent steps: it opens the draft PR and a human confirms it; `release` step, `monitor` stage and the monitor → classify loop are removed until v0.6 (ADR-0065) | An item is Done after its PR is confirmed; nothing waits on unavailable release tools | ✅ |
| X46 | Create issues in trackers | `IssueProposal` kind (agents propose via the `issue-proposal` skill → human approves; humans create directly), `Source.spec.writeBack.issues` permission + `SourceWritePolicy`, `IssueCreator`/`IssueFinder` connector capabilities, recoverable outbox `create-issue` (claim before effect, at most once without a human, `Uncertain` resolved by lookup or a human), mirror a manual item to GitHub/Jira, UI "Issues" (ADR-0066) | An agent finding becomes a GitHub issue / Jira story only after approval, never duplicated by retries; a mirrored item is never imported twice; read-only sources never receive writes | ✅ (§1–§7; ADR-0066 §8 later) |
| X47 | Self-resolving verification | Failures routed by cause (transient → wait, caused by the change → ADR-0059 recovery, pre-existing on the base commit → policy waiver from `Repository.verification.autoWaive` + follow-up); finding-aware classifiers (`npm-audit-json`); a pass with incomplete logs counts; step-budget exhaustion retries the unit attempt; no "explicitly retry" questions (ADR-0067) | The three observed blocks (pre-existing `security-scan`, truncated passing `unit-tests`, U5 budget exhaustion) resolve without human input; every automatic decision is a visible event and gate evidence. Known limits: follow-up is a `PolicyWaiver` event only (no ADR-0039 proposal until X46); gate baselines and policy waivers apply to unscoped checks; the budget is derived from deterministic keys, not a stored object | ✅ |
| X48 | Tracker follow-ups from work items | "Create follow-up" gets a destination: factory work item (ADR-0039) or a ticket in a Source with `writeBack.issues` (body from the reviewed evidence, created at once by the human, ADR-0066 delivery); agent findings shown as suggestions on the item; ticket status tracked on the origin item; "Start implementation" creates a linked work item (ticket as source, origin evidence carried); `propose_issue` requires a work item; optional Jira issue link to the origin (ADR-0068) | From a service desk item, one dialog creates a DHEI ticket with the investigation; the item shows its status; Start implementation creates a factory-plan item linked to the ticket that starts from the service desk evidence | ✅ |
| X49 | Browser notifications | Notifications projected from `Event`s by a rule registry (`NotificationClassifier`, severities action/problem/info), `notification` SSE frame, toasts → notification center (unread, catch-up, tab title) → opt-in desktop notifications (ADR-0069) | A clarification or approval request reaches a human in another tab or in the background within seconds; nothing is lost on reload | In progress (N1, N2 ✅; N3 built, desktop delivery not yet checked by hand) |
| X50 | Ticket history is mandatory | `ItemHistoryFetcher` port, Jira comments (visibility from `sd.public.comment`/`jsdPublic`/restrictions) + changelog in `WorkItem.spec.sourceHistory`; per-item: no history, no import/update (`HistoryUnavailable`); "Ticket history" in every prompt, the item digest and an item-page tab, internal comments flagged (ADR-0070) | A synced service-desk ticket's customer and agent comments reach the support engineer; an item whose history can't be read is not imported and the reason is visible | ✅ |
| X51 | Inline feedback | Select text in an artifact → popover: **Ask** the producing agent about the passage (its explain conversation, read-only) or add a **Feedback** note (draft, `InlineFeedback` kind); "Submit" sends all drafts as one batch: rejects the open gate when it re-runs the producing stage, else restarts from it; the next run of the producing step gets quotes + comments + the version read, once (`provenance.feedback`) (ADR-0071) | Notes on the spec at spec-review reach the product owner's re-run once; asking about a paragraph answers in the popover | ✅ |
| X52 | Plan gate waits for answers | With required decisions open, the plan gate shows "Approval waits for your answers" (open questions + link) instead of the approval form, the stage summary and a header badge say so, a disabled Approve states why; an answer binds to an option-less decision with the same question text (an agent re-recording an answered question) (ADR-0072) | An answered question recorded again by an agent is not asked again; with open decisions no approval form is shown | ✅ |
| X53 | One batch to the planner | A planning revision (answers, requested changes, reopen) also submits the draft inline notes on the stages it re-runs, same batch ID as the restart (`DraftFeedbackBatch` port, released on failure); the workspace shows how many go along (ADR-0073) | Answers plus notes reach the planner in one run; notes on earlier stages stay drafts | ✅ |
| X54 | Retire legacy code workflows | Remove `factory-loop`, `construction-bolt`, `factory-planned`, `factory-verified`; `github-issues`/`monitoring-feedback` default to `factory-plan`; verification migration (card button, `POST …/verification`, `VerificationActions.migrate`) removed; verification card only for workflows with a policy; engine tests use fixture workflows via `FactoryOptions.definitionLoader` (ADR-0074) | Production ships `factory-plan`, `servicedesk`, `factory-retrospective` only; a service desk item shows no "Legacy workflow" card and can't be migrated into the code pipeline; engine features stay covered by fixtures | ✅ |
| X55 | Item page from workflow capabilities | `CapabilityDetector` registry derives item capabilities (`planning`, `verification`, `checks`, `unit-execution`, `pull-requests`, `ticket-actions`, `retrospective`) from the compiled workflow, item and Source, "declared or used"; `WorkItemDetail.capabilities`; UI panel registry by region and required capabilities replaces self-hiding panels (ADR-0075) | A service desk item shows no code-pipeline panels (no Check evidence); a `factory-plan` item's page is unchanged; an item with existing checks keeps its check history after a workflow change | ✅ |
| X56 | Product owner drafts follow-up tickets | In the follow-up dialog's ticket destination, "Draft with product owner" turns the reviewed preview into a short ticket (problem, user story, SMART goal, Given/When/Then acceptance criteria, scope, cited notes) via the `ticket-writing` skill; the human edits, redrafts with feedback and creates (the reviewed body is approved); origin links are appended by the server, the evidence dump is gone; drafts are recorded in a `draft-ticket` conversation and `provenance.draftedBy`; template fallback without an LLM (ADR-0076) | A ticket created from a service desk item is short and plannable, its acceptance criteria cover the human's MUSTs, and it still links to the origin ticket and factory item | ✅ |
| X57 | OpenCode Code Mode and web tools | Enable Code Mode (`execute`) and web tools (`webfetch`, `websearch`) by default in OpenCode sessions; strip OpenCode's built-in `opencode_*` and `browser_*` tools; register factory and `ToolServer` tools with `codemode: true` while keeping `finish` direct (`codemode: false`); all calls recorded in transcripts (ADR-0078) | Agents can compose MCP/factory tools in `execute` and use `webfetch`/`websearch`; `opencode_*`/`browser_*` are unreachable; `finish` stays direct and last-step guarded | ✅ |
| X58 | Bubblewrap (`bwrap`) filesystem isolation | `BwrapEnvironment` (`isolation: "process"`, `IsolatedSnapshotEnvironment` with `isolatesCandidate: true`) confines commands to the workspace with read-only OS/toolchain binds, ephemeral `HOME=/tmp/home`, `--unshare-pid`, `--die-with-parent`, `--share-net`; `OpenCodeExecutor` supports `bwrap` and `OpenCodeHost.onShell` wraps shell commands in `bwrap`; `GitWorktreeWorkspaces` enabled for `bwrap` (ADR-0079) | Commands cannot see `$HOME` (`~/.ssh`, `~/.config`) or factory data dir while keeping outbound network; OpenCode shell runs inside `bwrap`; isolated snapshot checks cannot mutate candidate workspace | ✅ |
| P0 | Close the reachable security paths | **S0 first:** bind the UI/API to loopback, put the runtime-facing surface (proxy, tools) on its own listener or socket, real principals at the `principalFrom` seam, an origin check on state-changing routes and a CSP. Then the S0/P0 items in `docs/security.md` §7: the `realpath` guard for the sandbox file tools, untrusted-config git and credentials out of the child environment, `webfetch`/`websearch` out of `ALWAYS` and behind an egress proxy, fail-closed shell confinement, contract-suite escape cases, a protected-paths policy (CI definitions, ownership, attributes, lockfiles, test infrastructure) as blocking gate evidence, and the bwrap hardening of ADR-0081 | A sandboxed command cannot approve a gate, reach a decide route, or read the factory user's files; a candidate that weakens its tests or CI surfaces as blocking gate evidence; the SEC-1/2/3/5/15 tests pass | In progress (S0-1 loopback bind, S0-4 origin check + CSP ✅; S0-2/S0-3 deferred to the real-token work; ADR-0081 bwrap hardening ✅ — SEC-19/20; P0-1 file-tool realpath guard ✅ — SEC-1/14; P0-4 fail-closed shell ✅ — SEC-10 partly; P0-2 untrusted-config git + scoped token ✅ (mitigated) — SEC-2/3; P0-7 effective-vs-declared isolation ✅ — SEC-7; P0-9 egress proxy + `fetch_url` ✅ — SEC-5 mitigated (P0-3 pending); remaining P0 items pending) |
| X59 | AgentRuntime boundary | One `AgentRuntime` port (`bwrap`, `kubernetes`; a plain subprocess is not a runtime) hosting the agent loop, the workspace and the toolchain; a run is created, produces an exported commit, artifacts and transcript events, and is disposed; checks and verification run in factory-controlled runtimes from the exported commit; egress deny-by-default; the factory never runs `git` in a candidate and never executes workload code (ADR-0080) | Staged, each with a kill criterion: (S1) evidence comes from a runtime the candidate cannot influence; (S2) a real item completes on the `bwrap` backend with no provider key in the runtime; (S3) a Kubernetes run reaches nothing but the proxy and survives a factory restart by re-attaching; (S4) OpenCode runs inside the runtime at parity for every agent, and the in-factory control path is deleted | In progress (S1 export contract ✅ — ADR-0080 §13; S2-0/§10 `host` runtime removed ✅ — X61; S2-a ports + fake + executor seam ✅; S2-b `bwrap` backend + runner + factory-side tool surface + Unix-socket control server + `FACTORY_AGENT_RUNTIME_BACKEND=bwrap` wiring ✅ — a real run completes with the loop, tools and proxy inside bwrap, egress denied; diff-from-export + deadline ✅; S2-c route-allowlist cross-check ✅; a real item's developer step completes end to end on bwrap ✅ (S2 kill criterion); S3/S4 pending; design: `docs/agent-runtime-s2-design.md`) |
| X60 | Model proxy and run-scoped tokens | OpenAI-shaped proxy in the factory; per-run tokens bound to one `AgentRun`, with a model allowlist, step and token budgets, TTL, revocation on completion and per-request audit; the proxy is the authoritative control point for budgets, usage (ADR-0052) and quota waits (ADR-0031); no provider key ever enters a runtime (ADR-0080) | No runtime holds a provider key; every model call is attributable to a run and counted by the proxy; an over-budget run is stopped by the proxy, not by an in-runtime hook | In progress (proxy + run-scoped tokens built and tested; runtime wiring, usage rollups (X32) and the separate listener land with S2) |
| X61 | Isolation is a reviewed property | Remove the `host` runtime — `FACTORY_SANDBOX_RUNTIME=host` fails loudly, the adapter survives only as a test helper, and nothing executes without a namespace; `SandboxProfile.spec.acceptWeakerIsolation` replaces the environment-variable waiver, with effective and declared isolation recorded in run/check status and gate evidence; `ToolServer.spec.hostExecution` replaces "stdio requires the host runtime" and is recorded in provenance (ADR-0080 §10–§12) | A `container` profile without the field is refused on `bwrap`, one with it records `process` as the effective isolation; `kubernetes-crs` works with `bwrap` selected and the run's provenance shows the host process; no configuration weakens a declared minimum implicitly | ✅ (§10 `host` runtime removed — `FACTORY_SANDBOX_RUNTIME=host` fails loudly, adapter now a test helper; §11/§12 + P0-7 — SEC-7, SEC-12 partly) |
| X62 | Factory metrics | `MetricsQueries` read model derived from transcripts + resources: tool counts/time, tokens, time in agent vs tool, queue/wall time, check counts/durations, cost; tool-loop records usage + tool latency and the LLM adapters parse provider `usage`; optional versioned price schedule (`FACTORY_MODEL_PRICES`); a **Metrics** page and an item panel; **Prometheus/OpenMetrics export** (`/api/metrics/prometheus`, `prom-client`) for Grafana; unknown values omitted (ADR-0082) | An operator sees tools/tokens/time/checks/cost per item and factory-wide; an unrecorded value shows `—`, never `0`; Grafana can scrape the metrics; no runtime self-report is used | ✅ |
| X62a | Per-item and per-run metrics in the UI | Item metrics become a **Metrics** tab in the item's main card (totals, per-run table with a link from each row to that run, tool bars, checks, link to the factory page), replacing the collapsed `operational` panel so there is one item metrics surface; `GET /api/runs/{name}/metrics` + a `RunMetricsStrip` in the run drawer; shared `ms`/`n`/`usd`/`tokens` formatters and metric tooltips; Prometheus stays factory-wide (ADR-0090, refining ADR-0082) | An item's tools/tokens/time/checks/cost are one click from the item and never hidden behind a collapsed accordion; a single run's cost and agent-vs-tool time are visible in its drawer; an unrecorded value shows `—`, never `0`; the factory Prometheus export is unchanged | ☐ |
| X63 | Review scope from OpenCodeReview | OpenCodeReview in **delegation mode** (no LLM, no OCR provider): a `resultFormat: ocr-delegate-preview` check records the reviewable files of the candidate and the reason every other changed file is excluded; a check command may name `{{base}}`, resolved by the factory from the workspace's pinned base commit; the `review-scope` definition entry and its `preparationChecks` binding ship with the toolchain, so a policy change cannot invalidate in-flight plans for a check that cannot run yet (ADR-0083) | The item's check evidence names the reviewable files and every exclusion reason, bound to the pinned base; a missing CLI is `Unavailable` and inconsistent output is `NotVerified`, never a pass, and a check that produced no evidence appears in the timeline, the check panel and as a notification | In progress (X63a: format, `{{base}}` resolution and classifier ✅; X63b: pinned `ocr` in the runtime toolchain + definition entry + `preparationChecks`; X63c: scope digest in the reviewer's context with a typed, coverage-carrying `code-review-report`) |
| X64 | Story refinement | Workflow `story-refinement` (research → product-owner `ticket-draft` with `ticket-writing` → story-review [human] → publish-ticket); reusable `publish.issue` stage block through a `StagePublisher` registry creates one `story` IssueProposal per item, bound to the approving gate decision and the exact draft version, delivered by the ADR-0066 outbox; `WorkItem.spec.ticketTarget` chosen in New item ("New ticket" preselects the workflow); Start implementation carries the item's research (ADR-0084) | An idea becomes a researched Jira story in one item; only the human-approved draft is published, exactly once; a rejection is redrafted; a restart never edits or duplicates the ticket; the implementation item starts from the research | ✅ |
| X65 | Restart with context and notes | Restart → From <stage> opens a dialog: edit the additional context (written with the restart) and send the draft inline notes on the re-run stages in the restart's batch (released if the restart fails); `RestartOptions` on `restartWorkItem` and the restart API (ADR-0085) | A human goes back to `plan` with new decisions and their spec note in one action; the first re-run sees both; notes on earlier stages stay drafts | ✅ |
| X66 | Name failing tests, recognize flaky ones | Test checks report per-test results (`node-test-tap`: any test-code failure is a named failure; hooks, crashed files, cancellations stay unknown; `status.tests` with touched files via `CandidateChanges`, `outputTail`); flaky = every failure passed in another attempt or targeted re-run on the same snapshot and the change touched none of the files; untouched failures are confirmed (targeted `rerunFailed`, names only as quoted variables, never a pass; else another attempt) before a code fix; readiness counts flaky as ready, verify re-runs then offers the waiver, `autoWaive when: flaky`; opaque failures ask with evidence; `FlakyTest` events, 3 in 7 days propose one issue (ADR-0086) | The observed readiness blocks (two flaky tests failing alternately) resolve without human input; real failures name their tests; flakiness is visible and leads to a fix | ✅ |
| X67 | One decision per recorded question | `PlanningService.decisions()` keeps the first recording per `normalizeQuestions` id and carries the question's options into the sheet; a `question-…` decision binds an answer by its text even with options, plan decisions still need a matching signature (ADR-0087) | A question several agents recorded under one id appears once with its choices; an answered question is not asked again | ✅ |
| X68 | Declared tools and a factory-owned toolchain cache | `SandboxProfile.spec.tools[]` (name + `provides` + `via.type`), a `ToolProvisioner` registry (`goInstall`, `command`), a persistent factory-owned cache mounted at `/factory-tools`, first on `PATH`, with `GOBIN`/`GOPATH`/npm/pip/cargo caches and a factory-owned `HOME`; installed before a sandbox is handed out; `SystemHealth.toolGaps` + a health badge (ADR-0088) | A repository declares the tools it needs instead of scripting installs and `PATH` plumbing in every check; a missing tool is a visible gap, not a cryptic `SetupFailed`; a `scoped` check finds the tool without setting `PATH` itself | ✅ (S1: cache, provisioners, readiness. Detectors and provisioning inside `AgentRuntime` follow) |
| X69 | Precise, candidate-proof module scope | Dependency manifests scope to their owning module instead of `sharedPaths`, the module graph is read from the pinned base commit so a candidate cannot narrow its own scope, and `controlplane`'s `full-build`/`full-tests` become scoped aliases so no check runs the whole monorepo; genuinely shared tooling still runs full (ADR-0089, amending ADR-0044/0061); the `go-build` profile pins `GOTOOLCHAIN` so code generation is reproducible | A dependency change builds only the affected modules and their dependents; unrelated modules are never built or regenerated; a candidate cannot influence its own scope | ✅ |
| X70 | Publication owns its branch | `GitBranchPublisher` reads the remote head and pushes with `--force-with-lease`, so a moved `factory/*` head (a human's "Update branch" merge) is replaced by the reviewed candidate instead of wedging the outbox in a retry loop; the base is still reconciled through ADR-0053, and the push still runs from the factory-owned bare mirror (ADR-0091) | A human action on the pull request never blocks publication; a concurrent push still loses safely (the lease fails and the delivery retries) | ✅ |

#### Later increments
| Version | Increment | Highlights |
|---|---|---|
| v0.2 | Write-back | ✅ see table above |
| v0.3 | Construction for real | see table above (ADR-0019); generic Bolt fan-out per Unit moves to v1.0; sequential planned Unit execution is X27 |
| v0.4 | Auth & squads (**postponed**, ADR-0025) | OIDC, `User`/`Role`/`Squad`, RBAC, namespaces per squad, `squads/<squad>/…` definitions (ADR-0009, ADR-0011) |
| v0.5 | Tool servers | ✅ `ToolServer` (MCP) kind + `ToolProvider` port, factory as MCP server (X16, ADR-0034); open: per-squad tools (ADR-0011), delegation as tool calls |
| v0.6 | Operations | Ship + monitor for real, feedback WorkItems with code research, rollback |
| v1.0 | Hardening | Postgres, worker leases, embeddings search (optional), observability of the factory itself, generic Bolt fan-out per Unit |

Known MVP simplifications: definitions load once at startup (restart to reload); `forEach` runs the sub-workflow once (the opt-in planned path implements Units sequentially, X27); automated checks pass
with a warning event; no auth, but the code stays auth-ready (rule 9). Checks can run in a separate worker (X42); agent runs stay in the web process.

---

## 5. Changing the plan (ADRs)

- Every change to architecture, the plan, the rules, the resource model, or the tech stack **requires an ADR** in
  `docs/adr/NNNN-kebab-title.md`, using `docs/adr/0000-template.md`.
- ADRs are append-only. To change a decision, write a new ADR that **supersedes** the old one, and set the old
  ADR's status to `Superseded by ADR-NNNN`.
- Update `AGENTS.md` (and the milestone table) in the **same change** as the ADR.
- Small implementation details that stay within existing ADRs don't need an ADR.

## 6. Harness (sub-agents & skills)

| Type | ID | Use |
|---|---|---|
| Sub-agent | `architecture-reviewer` (`.opencode/agents/`, `.github/agents/`) | **Required** at the end of every §4 item and for non-trivial changes. Read-only; the Copilot version uses caller-provided diffs and check results. |
| Skill | `interface-first` (`.agents/skills/`) | Any change in `web/src/core` |
| Skill | `add-extension` | Adding a new pluggable "type" (connector, gate, check, executor, …) |
| Skill | `add-resource-kind` | Adding a new kind |
| Skill | `controller-pattern` | Writing or changing a controller |

Model choice: the reviewer uses a mid-tier model (`claude-sonnet-5.5`). Cheap models (e.g. `claude-haiku-5.5`,
`gemini-3.8-flash`) are for easy, low-risk helpers only. Add new harness pieces to this table.

## 7. Definition of done (per change)

- [ ] Ports defined or updated first. ISP respected.
- [ ] Wiring only in the composition root.
- [ ] `npx tsc --noEmit` passes in `web/`.
- [ ] Tests pass: `npm test` (all), `npm run test:integration` (composition-root suites) and `npm run test:acceptance`
      in `web/`. Acceptance tests live in `web/src/acceptance/*.acceptance.test.ts`, one per delivered acceptance
      criterion, named with its ID (`AC-3: …`) and exercising the public app/API surface.
- [ ] `python tools/validate.py` passes.
- [ ] Docs, glossary, and ADRs updated if concepts or decisions changed.
- [ ] Milestone status updated.
- [ ] `architecture-reviewer` run, with no blocking findings (when closing a §4 item).

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
  `OutboxMessage`, `KnowledgeEntry` (ADR-0030), and `CheckRun` (ADR-0042), all modeled as custom resources (`apiVersion / kind / metadata / spec / status`). Agent
  **transcripts** are stored separately in an append-only log (ADR-0012).
- **Factory loop** (diagram: `docs/ai-dlc-glossary.md`):
  input (manual | Jira | GitHub | monitoring) → classify → triage → spec → spec-review [human] → implement →
  code-review [human] → verify → ship [human] → monitor → repeat
- **UI:** a dashboard (table) of WorkItems. You can create items manually, sync them from sources, answer clarifications
  (which unblocks items), and approve or reject gates.
- **code-researcher:** a shared, read-only agent that any agent (mainly the triager and the SRE) can delegate to.
  It researches the `Repository` code and writes `research-notes` into the WorkItem.

Required reading:
`docs/ai-dlc-glossary.md` (vocabulary), `docs/architecture.md` (entities, lifecycle, UI), `docs/patterns.md` (patterns),
`docs/adr/` (decisions).

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
    with `FACTORY_SIMULATION=wait` (ADR-0029).

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
| S4 | First real adapter | `host` (ADR-0020, explicit opt-in, unsandboxed, per-item Git worktree); container/kubernetes adapters later | Real run on the dev machine | ✅ host · ☐ isolated adapters |
| S5a | Workspace resource (ADR-0021) | `Workspace` kind + controller, `WorkspacePreparer`/`WorkspaceCleaner` ports, host worktree adapter, setup commands, items wait for Ready, code search + sandboxes use the workspace, provenance `repo@commit` | All agents of an item see the same pinned code state; workspace visible + cleaned up | ✅ |
| S5b | Read-only code tools for analysis agents | `read_file`/`list_files`/`search_code` on the workspace for triager, architect, reviewer | Reviewer reads surrounding code, not only the diff | ✅ |
| S5c | Real checks + draft PR | `build`/`unit-tests` gate checks in the workspace, push branch + draft PR through the outbox | End-to-end PR from a work item | ✅ (draft PR #1 opened by the factory) |
| U1 | Navigation | Left navbar with entities (work items, definitions, workspaces); generic resource list/detail views | Every kind browsable from the UI | ✅ |
| Q1 | Review → fix loop | Stage-level `loop` (outcome → goto, bounded): AI code review returns `changes-requested` for blocking findings, the developer gets the review as input and fixes before the human gate | Blocking AI findings are fixed automatically (max N rounds), then humans review | ✅ (ADR-0024) |
| Q2 | Visible control-loop errors | `ReconcileErrorReporter` port: repeated reconcile failures become Warning events on the object; failing-controller count in system health + UI badge | A stuck item shows why in its timeline | ✅ (ADR-0024) |

Known v0.3 limits: on legacy `factory-loop`, failed check output is not fed to the developer as input (AI reviews and human gate comments are), checks re-run after a restart (in-memory cache), and the verifier's verdict is advisory. The opt-in `factory-verified` path addresses these check limitations (ADR-0042). Workspaces fork from the **committed** HEAD (uncommitted local changes are invisible to agents); only `host` has a workspace backend so far; tool results go to the model unredacted, which is safe
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
| X16 | MCP | Factory as MCP server (`/api/mcp`, bearer `FACTORY_MCP_TOKEN`, no gate tools) + `ToolServer` kind / `ToolProvider` port for agents (http; stdio with host opt-in); `support-engineer` uses the factory's own MCP for knowledge (ADR-0034) | A local harness creates and answers items via MCP; an agent calls an MCP tool in its run (recorded) | ✅ |
| X17 | Kubernetes CR MCP | Standalone stdio server with YAML-allowlisted CR types, namespaces and reference hierarchy; discovery, label-filtered list, get and bounded hierarchy; support engineer integration (ADR-0035) | Standalone protocol/API tests pass; agent integration uses existing MCP recording; no cluster writes or credential exposure | ✅ |
| X18 | Direct agent chat | Standalone `agent-chat` Conversations, explicit read-only MCP policy and answer completion, durable serialized turns and waiting/error states, resumable UI, human conversion to WorkItem (ADR-0036, ADR-0038) | Support engineer investigates via recorded tools without a WorkItem; announcements cannot end a turn; restart/retry preserves messages; conversion preserves human gates | ✅ |
| X19 | Work-item agent chat | Optional `workItemRef` on direct chats, shared bounded evidence digest refreshed and recorded per turn, start/resume from item or Chats (ADR-0037) | Agent uses item evidence plus allowed MCP reads; new turns see updated context; workflow and gates remain unchanged | ✅ |
| X20 | Work-item follow-ups | Human-created independent items with selected workflow/repositories, reviewed evidence snapshot and separate free-text instructions (ADR-0039) | Preview is bounded and stale-safe; retries deduplicate; new agents see instructions and evidence; origin, gates and deletion lifecycle stay independent | ✅ |
| X21 | Reviewed Jira actions | Fresh publication review after response review, explicit public/internal replies, optional follow-on or standalone Jira transitions through the outbox (ADR-0040); automatic service-desk sync remains read-only | Exact response/visibility reviewed; live allowed transitions; durable receipts and safe crash recovery; existing completed items never post automatically | ✅ |
| X22 | Agent retrospectives | Workflow feedback with pinned provenance, deterministic support thresholds, separate proposal-only retrospective workflow, human review and manual implementation follow-up (ADR-0041) | Deduplicated eligible support creates one investigation; evidence survives origin deletion; human review is durable; originating workflows and publication permissions stay unchanged | Planned (ADR proposed) |
| X23a | Reliable check execution | Structured CheckRun lifecycle/outcomes, configurable per-check budgets, durable redacted logs/results and evidence UI (ADR-0042) | Check identity and tested snapshot are pinned; interrupted execution recovers; results deduplicate and survive restart; missing evidence is never a pass | ✅ |
| X23b | Evidence-driven recovery | Typed failure routing, separate execution/code retry budgets, durable human attention and developer check-failure input (ADR-0042; after X23a) | Timeout, cancellation and setup failure do not trigger blind code-edit loops; repeated unchanged failures escalate with actionable evidence | ✅ |
| X23c | Verification contracts | Reviewed validation plans, same-environment preflight, shared agent/gate check runner, snapshot freshness and required-evidence enforcement (ADR-0042; after X23b) | Required evidence or explicit policy-permitted waivers are bound to plan/candidate; stale or simulated evidence cannot pass; existing gates and publication permissions remain intact | ✅ |
| X24 | Candidate preparation and recovery | Pre-review named preparation checks, active-job waits, bounded return-to-review on drift and explicit check selectors (ADR-0043) | Builds cannot race review; regenerated code gets fresh review; clarification answers cannot impersonate approval; preparation never replaces verification | ✅ |
| X25 | Affected-module verification | Repository dependency graph selects changed modules and transitive dependents for named build/test checks across preparation, agents, gates and manual execution (ADR-0044) | Immutable scope provenance; committed and dirty changes covered; shared/unknown changes use explicit full scope; plans and human approvals remain revision-bound | ✅ |

#### Later increments
| Version | Increment | Highlights |
|---|---|---|
| v0.2 | Write-back | ✅ see table above |
| v0.3 | Construction for real | see table above (ADR-0019); Bolt fan-out per Unit moves to v1.0 |
| v0.4 | Auth & squads (**postponed**, ADR-0025) | OIDC, `User`/`Role`/`Squad`, RBAC, namespaces per squad, `squads/<squad>/…` definitions (ADR-0009, ADR-0011) |
| v0.5 | Tool servers | ✅ `ToolServer` (MCP) kind + `ToolProvider` port, factory as MCP server (X16, ADR-0034); open: per-squad tools (ADR-0011), delegation as tool calls |
| v0.6 | Operations | Ship + monitor for real, feedback WorkItems with code research, rollback |
| v1.0 | Hardening | Postgres, worker leases, embeddings search (optional), observability of the factory itself, Bolt fan-out per Unit |

Known MVP simplifications: single process (no leases); definitions load once at startup (restart to reload); `forEach` runs the sub-workflow once; automated checks pass
with a warning event; no auth, but the code stays auth-ready (rule 9).

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
| Sub-agent | `architecture-reviewer` (`.opencode/agents/`) | **Required** at the end of every §4 item and for non-trivial changes. Read-only. |
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
- [ ] `python tools/validate.py` passes.
- [ ] Docs, glossary, and ADRs updated if concepts or decisions changed.
- [ ] Milestone status updated.
- [ ] `architecture-reviewer` run, with no blocking findings (when closing a §4 item).

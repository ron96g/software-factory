# ADR-0080: AgentRuntime as a data plane (the factory never executes workload code)

- **Status:** Accepted. Extends ADR-0019, ADR-0020, ADR-0060, ADR-0079; amends ADR-0019 §3 and §5 and ADR-0060 §4;
  changes the workspace premise of ADR-0021 and the publication mechanics of ADR-0023.
- **Date:** 2026-11-22
- **Deciders:** project owner

## Context

`docs/security.md` records 14 open findings. The load-bearing one is not a bug: **the boundary is in the wrong place.**

1. The factory holds everything worth taking (assets A1–A8: push credentials for managed repositories, provider keys,
   connector tokens, every workspace, the store, the cluster identity, and — until S0 lands — its own gate authority over
   an unauthenticated API, `SEC-15` in `docs/security.md`) and the agent runtime — the component steered by
   untrusted ticket text, repository instructions and fetched pages — runs *in the factory's process, as its OS user, on
   its filesystem*.
2. Isolation today covers **commands only**: `SandboxExec` and OpenCode's `shell`. Everything else the agent can reach
   executes in the factory's trust domain — the file tools (`SEC-1`), OpenCode's own `read`/`edit`/`write` (`SEC-10`),
   `webfetch`/`websearch` (`SEC-5`), workspace `setup` (`SEC-4`), and the git plumbing we run on the candidate
   (`SEC-2`, `SEC-3`). Commands keep the host's full network reach (`SEC-6`), and a runtime that cannot provide the
   profile's isolation downgrades it invisibly (`SEC-7`).

The planned Kubernetes sandbox (a pod per work item running the item's commands, ADR-0019 §3) improves the sandbox
*primitive* — namespaces, cgroups,
NetworkPolicy, microVM class — but does not move the boundary:

- with the workspace in the pod, **OpenCode cannot run at all** in the factory (its file tools resolve a host path), so
  code-writing agents would lose their native tools and stay on the tool loop;
- `CheckExecutionRunner` would share a runtime with the candidate it measures, so the candidate's own code could
  influence its evidence — weaker than today, where only the check *command* is sandboxed and the runner is host-side;
- the factory would still commit and push from a tree the agent can write, so the git-config execution class survives.

A first evaluation of this was written up in `docs/security.md` §7 as "P2 — move the execution plane". This ADR turns that
ideal into the target architecture and states the contract.

## Decision

### 1. Two planes, one rule

| Plane | Contains | Must never |
|---|---|---|
| **Control plane** (the factory) | controllers, workflow, gates, approvals, outbox, store, secrets, connectors | execute workload code; read workload-controlled configuration (git config, hooks, filters, package scripts); treat runtime-reported data as observed fact |
| **Data plane** (`AgentRuntime`) | the agent loop (OpenCode host + plugin), the workspace, the toolchain | hold a long-lived secret; write to the store; hold authority (no gate decision, no approval, no publication) |

The interfaces between them are exactly four: the **run job API** (in), the **model proxy** (in), the **scoped tool
surface** (in), and the **export contract** (out).

### 2. One `AgentRuntime` interface, several backends, enforced isolation

`AgentRuntime` is one port with implementations: `bwrap` (local development, real namespaces), `kubernetes` (a pod per
run, microVM class through `runtimeClassName`), and `none` (simulation, no execution — there is no unsandboxed runtime;
`host` is removed by §10). The **process model is irrelevant** — only the primitive is. A plain subprocess of the factory
is not a runtime, and the `ExecutionEnvironment` isolation rules of ADR-0019 §4 continue to apply: a profile's minimum
isolation is enforced, never waived implicitly (SEC-7; §11 moves the waiver into the profile), and the selected backend,
its version, its effective isolation and the declared minimum are recorded in provenance.

### 3. A runtime is per run, and its outputs are data

A run is created, does one thing, and is disposed. It produces (a) a **candidate commit exported into a factory-owned
mirror**, (b) artifacts, (c) transcript events with run-scoped sequence numbers. The factory consumes these **as data**:
it never runs `git` inside the candidate, never reads the candidate's configuration, and never executes anything it
received. Worktree-on-live-checkout workspaces (ADR-0021) are retired for this path, which also removes the coupling
between the factory's own repository and an item's workspace.

Per-item caches (build caches, toolchains) live on a separate volume, not on the runtime: warm caches are an
optimization, never a prerequisite. A cache written by one run is **untrusted input** to the next, so caches are keyed
per item (or per base commit) and anything that produces evidence — checks, verification — never mounts a writable
cache.

### 4. Model access through the factory's proxy

The runtime never receives a provider key. It receives a **run-scoped token**: bound to one `AgentRun`, with a model
allowlist, a step budget and a token budget, a TTL, revoked at completion, and every request recorded. The proxy is
strictly model-shaped — no generic fetch or forward — so it cannot become an egress channel.

Because every model call passes through the proxy, the proxy is the **authoritative** control point for step budgets,
usage accounting (ADR-0052), and quota waits (ADR-0031). This is stronger than an in-runtime hook, which a compromised
runtime can simply not call.

### 5. Factory tools over the existing scoped MCP surface

Factory tools (`search_knowledge`, `run_check`, `check_logs`, `propose_issue`, `finish`, …) and `ToolServer` tools are
exposed to the runtime through the factory's MCP surface (ADR-0034, X16). Consequences: `ToolServer` credentials stay in
the factory; every call is re-authorized against the run's offering, rate-limited per run, idempotent, and recorded into
that run's transcript; **no gate, approval or publication tool is ever exposed.**

### 6. Checks and verification run outside the agent runtime — and the ADR states what the evidence means

The runtime produces a commit; a **factory-controlled** runtime is provisioned from that pinned commit, with a fresh
volume and the profile's resources, to run checks and collect evidence. Therefore:

- the runtime that *records* the evidence cannot be influenced by the candidate: it cannot forge, drop, replay or rewrite
  a result (X23a/X23c);
- "no check may modify the candidate" (X41b) holds **by construction**;
- mutations and checks can never overlap (X41c) — the factory serializes runs, and the candidate is immutable once
  exported.

**What this does not fix, and must not be claimed as fixing: the meaning of the evidence.** A check runs the candidate's
own test command through the candidate's own test infrastructure — `package.json` scripts, `jest.config.*`,
`conftest.py`, `go test` flags, Makefiles — so a candidate can make its checks pass by weakening, skipping or deleting
tests. What is recorded is "the configured command exited 0 on this commit", not "the code works". Two consequences:

- changes to test infrastructure and check configuration are **blocking gate evidence** at publication (the
  protected-paths policy, SEC-18/SEC-21), so a human sees them before approving;
- the `verification` tier may bind the check *configuration*, not only the command, to the base commit.

### 7. Egress is deny-by-default and enforced at the network layer

`SandboxProfile.spec.network` becomes an enforced property (`none` / `allowlist`), not documentation. For a `none`
profile the model proxy and the factory's tool surface are the only reachable destinations. `webfetch`/`websearch`
become an explicit capability routed through the factory's egress proxy, with an allowlist, a per-run budget and
recorded destinations. Registries are allowed only where a profile declares them.

**What egress control does not close.** Denying egress bounds the *network* channel, not every channel. The runtime can
still put data into: tool arguments (an `http` `ToolServer` is called by the factory, so its arguments leave from the
factory's position), issue proposals, artifacts, the exported commit, and the PR branch and body that a human publishes.
A stolen run token can be replayed until it is revoked. These are accepted residual channels (AC-7 in
`docs/security.md`), each with a limit: per-run token TTL and revocation, size and rate limits on tool arguments and on
ingested transcript events, and human review of everything that leaves the factory for the customer. A new channel added
to the runtime protocol must be listed here with its limit, or it is an unbound exfiltration path.

### 8. Recording: observed versus reported

Rule 14 is preserved in substance and sharpened in wording. The factory records **what it observes** — model calls and
usage (proxy), tool calls (MCP surface), artifacts, exports — as its own record. Runtime-submitted transcript events are
stored and marked `runtime-reported` in provenance. A runtime that omits or forges its own events cannot change what
the factory saw, and the controls that matter (budgets, offerings, evidence) are factory-side.

### 9. Authentication becomes a first-class increment

Run-scoped tokens need issuance, scope, revocation, audit, and transport security, and every call needs a principal.
Rule 9's `Principal` discipline is the seam; this increment is delivered with the runtime protocol, not after it.

### 10. No execution without a primitive — the `host` runtime is removed

ADR-0020 added `host` as an explicit, unsandboxed opt-in. It is the only runtime that provides **no** isolation, and it
cannot even do the whole job: `HostEnvironment.isolatesCandidate` is `false`, so `CheckExecutionRunner` refuses
diagnostic and baseline execution on it (`check-runner.ts:37`). Everywhere it is used it means "commands, file tools,
checks and the evidence a human approves all run as the operator".

Isolation becomes a **floor** rather than a choice: agent code either runs inside a namespace (container, microVM) or it
does not run at all — simulation or a wait carries the visible reason (ADR-0029). Concretely:

- `HostEnvironment` disappears as a runtime: no registration in the composition root, no entry in `auto`, and
  `FACTORY_SANDBOX_RUNTIME=host` **fails loudly** at startup with a message naming the replacements instead of falling
  back silently.
- Its code survives only as a **test helper** under `core/testing/`, exported for tests and unreachable from the
  composition root, because several suites need a real filesystem for OpenCode's editor tools.
- Local execution is `bwrap`; cluster execution is the Kubernetes backend (§14, S3). The removal itself needs only
  `bwrap`, so it lands in S2 — after which an environment with neither (macOS, an unprivileged container) gets simulation
  until the `podman`/`docker` adapter of ADR-0019 §3 exists.
- Rule 18 loses its `host` clause, and ADR-0020 becomes *Superseded*.

### 11. The isolation requirement lives in the definition, not in an environment variable

Today `FACTORY_SANDBOX_RUNTIME=bwrap` flips `waivesIsolation: true` (`factory.ts:285`, ADR-0079 §2), which downgrades
**every** profile from `container` to `process` for agents and checks alike, with only a transcript note as evidence
(SEC-7). The waiver itself is necessary — the shipped profiles declare `isolation: container`
(`sandbox-profiles/profiles.yaml`) while `bwrap` provides `process`, so without it nothing runs locally — but the
decision belongs in the reviewed definition, not in how the process was started.

- New field `SandboxProfile.spec.acceptWeakerIsolation` (default `false`): "if the selected runtime cannot provide
  `spec.isolation`, it may be used at the strongest level it does provide".
- The environment variable keeps choosing **which** runtime to use; it never weakens a declared minimum again.
- `auto` never waives, in any circumstance (ADR-0079 §2 continues to hold).
- Every agent run and check records the **effective** isolation next to the **declared** one, and gate evidence renders
  both — "process; profile asks container, allowed by the profile" — so a reviewer approving evidence can see it.
- Local development is restored by adding the field to the profiles that need it (`node-build`, `go-build`): a reviewed
  change in Git, and inert in a cluster, where the stronger runtime satisfies the profile anyway.

### 12. Host process execution is a per-definition decision

MCP `stdio` servers are allowed today only when the selected sandbox runtime is `host` (`run-harness.ts:171`,
`agent-chat.ts:91`, message in `adapters/mcp/client.ts:55`). Picking a sandbox therefore silently decided the tool-server
transport policy — and removing `host` (§10) would silently remove `kubernetes-crs` (`tool-servers.yaml`, the ADR-0035
Kubernetes CR MCP) along with it.

- New field `ToolServer.spec.hostExecution` (default `false`): this definition starts a local process as the factory user.
- Definitions are reviewed input (AC-6), so the permission is granted where it can be reviewed — next to the command it
  protects — instead of being implied by an unrelated runtime selection.
- The flag is recorded in the run's provenance, so a reviewer can see that the run spawned a host process.
- A tool server that needs no host process should move to `http`; the factory's own MCP surface (X16) is the natural home
  for it.
- **The default is not "run it inside the sandbox".** For a server that holds a credential — `kubernetes-crs` uses the
  operator's cluster identity (A7) — moving it into the runtime would move that credential into the agent's trust domain,
  which is the property this ADR exists to remove. Preference order: (a) `http` with a scoped credential, run where it is
  today; (b) factory-side `hostExecution` with a **scoped** credential (read-only RBAC, never the operator's own
  kubeconfig) and its use recorded in the run's provenance; (c) inside the runtime only when the server needs nothing the
  runtime does not already have.

### 13. The export contract (where untrusted data enters the factory)

§3 says a run produces an exported commit. That commit is the one interface where data flows **into** the factory, so it is
specified rather than left to the adapter:

- **Mechanism:** the runtime exports a bundle (or a `fast-export` stream) — never a working tree, and never a repository
  the factory runs anything inside.
- **Ingest:** a factory-owned **bare** mirror; `git index-pack --strict` plus `git fsck` over the incoming objects;
  explicit limits on pack size, object count and ref count; and the factory **never checks out** the commit — it reads
  trees, blobs and diffs through plumbing only.
- **Policy:** symlinks are recorded but never followed; submodules are refused (or recorded as unresolved, never fetched);
  filters, hooks, attributes and configuration carried by the incoming objects are never applied. The ingest runs with
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and `-c core.hooksPath=/dev/null` in a scrubbed environment —
  consistent with SEC-2/SEC-14, which is precisely why it must not inherit a workspace.
- **Trust:** everything inside the bundle is untrusted input — the commit message, author identity, paths and file
  contents are data, never instructions — and it is rendered as untrusted content in the UI (SEC-16).
- **Limits are part of the contract:** transcript events submitted by the runtime and tool arguments entering from it have
  size and rate limits, and the factory rejects what exceeds them rather than storing it (the ingestion side of AC-7).

### 14. Staged delivery, each stage valuable on its own

| Stage | Deliverable | Kill criterion (what must be true to keep going) |
|---|---|---|
| **S0** *(prerequisite)* | The security-hardening milestone in `AGENTS.md`: loopback binding, a separate runtime-facing listener, origin checks on state-changing routes | A `curl` to a decide route from inside the sandbox fails, and a cross-origin POST fails; the runtime-facing surface carries no decide/review/publish route |
| **S1** | Export contract (§13) + checks/verification from the exported commit | Snapshot freshness and required-evidence tests (X23c) pass against the export; the ingest rejects oversized, symlinked and submodule-carrying bundles; nothing in the candidate's runtime can forge the evidence |
| **S2** | `AgentRuntime` port with the `bwrap` backend; **the agent loop runs inside the runtime** (the tool loop first — S4 switches it to OpenCode), with the model proxy and the tool surface as its only reachable endpoints; §11 and §12 land here; §10 (removing `host`) lands here too, because it needs only `bwrap` | A real item completes end to end with the loop inside the runtime; the only factory endpoints reachable from inside it are the proxy and the tool surface; nothing in the runtime holds a provider key; a `container` profile without `acceptWeakerIsolation` is refused on `bwrap`; `FACTORY_SANDBOX_RUNTIME=host` fails with a message naming the replacements; the SEC-1/SEC-2/SEC-3 tests cannot be reproduced |
| **S3** | Kubernetes backend: enforcing egress (NetworkPolicy, with a CNI that actually enforces it), `automountServiceAccountToken: false`, the cloud metadata endpoint blocked, pod security admission, and per-profile resources | A `curl` to the internet from the runtime fails while the proxy works; the metadata endpoint is unreachable; a run survives a factory restart by re-attaching rather than by losing evidence |
| **S4** | OpenCode runs inside the runtime; the in-factory control path is deleted | Parity on real items for every agent (the X40 pattern): the plugin is a convenience, not a control; `ShellConfiner`, host-side `SandboxFiles` and the tool loop as default are removed |

## Consequences

**Retires by construction** (for any runtime with a real primitive): SEC-1 (file-tool symlink escape), SEC-2 (host `git`
in agent-writable repositories), SEC-3 (the token in git's environment), SEC-4 (workspace setup on the host), SEC-8 (the
structural finding: no boundary between the decider and the secret holder) and SEC-10 (OpenCode's tools as
policy-only). It also restores the premise AC-5 relies on — "sandboxes never receive factory secrets" — and §10 retires
AC-3 by removing the runtime that made it necessary.

**Addressed directly**: SEC-5 and SEC-6 by §7 (agent-initiated HTTP goes through the factory's egress proxy with an
allowlist and an audit record; a profile's declared `network` mode is enforced), SEC-9 by S3 (the runtime gets its own
resource limits), SEC-7 by §11 (the waiver becomes a reviewed profile field, recorded as effective-versus-declared
isolation in run and check status) and SEC-12 by §12 (host process execution becomes a reviewed definition field,
recorded in provenance).

**Remains open, to be closed by the other workstreams** in `docs/security.md` §7: SEC-11 (value-based redaction — the
store still needs encryption, retention and provenance for tool reads; P1-4), the remainder of SEC-12 (tool-server
traffic still leaves from the factory's network position, which §12 does not change; P0-9, P1-3), SEC-13 (the
documentation gap, closed by `docs/security.md`) and SEC-14 (the contract-suite escape cases; P0-5).

**New costs and risks:**

- **The factory becomes a distributed control plane.** Run lifetimes, crash and partition handling, re-attachment,
  idempotent submission and fenced leases (X42) are pulled forward from "planned" to "required".
- **A runtime image becomes a shipped artifact**: OpenCode + the factory plugin + per-repo toolchains, pinned,
  versioned, multi-arch, and recorded in provenance — with a rejection path on version mismatch.
- **Toolchains versus closed egress.** `network: none` breaks `go get`/`npm install`/`envtest`. Profiles must choose:
  prebuilt per-repo images, a registry mirror behind the egress proxy, or a pre-warmed cache volume.
- **Local development needs the local backend**, or runs become undebuggable.
- **It replaces the agent execution path**: the in-process plugin's role as a security control, `ShellConfiner`, the
  host-side `SandboxFiles` implementation, `GitWorktreeWorkspaces` for this path, and most host-side git plumbing. The
  tool loop survives as a fallback and simulation path only.
- What is **not** invalidated: the resource model, controllers, workflow compiler, gates, evidence semantics, outbox,
  sources and the UI.

**AGENTS.md sections and milestones affected:** rule 8 (gate decisions happen only on a surface the runtime cannot reach,
through an authenticated principal, with an origin check) and rule 18 (extended: the factory executes no workload code and
reads no workload-controlled configuration; on acceptance it also loses the `host` clause); §4 milestone table — the
hardening milestone **P0** (the S0 prerequisite) plus X59 (runtime boundary and export contract), X60 (model proxy and
run-scoped tokens) and X61 (isolation is a reviewed property: no `host` runtime, per-profile waiver, per-definition host
execution) added as *Proposed*; X40 (OpenCode runtime) and X41 (verification tiers) gain explicit sub-items; X42 (check
worker) moves from "planned" to a prerequisite; required reading already names `docs/security.md`. On acceptance,
ADR-0020 becomes *Superseded*, ADR-0019 §3/§5, ADR-0060 §4 and ADR-0079's consequences get an amending note, and
`docs/security.md` §7 changes from a long-term ideal to the committed target.

## Alternatives considered

- **Keep the agent in the factory; put a microVM around the commands** (ADR-0019 §3 as literally written): rejected. It
  strengthens the primitive without moving the boundary: the provider key, `webfetch`, the git plumbing and the
  authority stay in the same process as the agent, and OpenCode becomes unusable on a pod-local workspace.
- **Helper daemon in the pod (remote filesystem/exec; agent loop stays in the factory):** rejected as the target — it
  keeps the in-process plugin as a control, leaves the provider key and the web tools in the factory, and does not give
  OpenCode's native tools. Acceptable as a transitional step inside S2, not as the destination.
- **Run checks inside the agent runtime** (cheaper, one runtime per item): rejected — it puts the party that measures the
  candidate inside the candidate's blast radius and would regress the evidence guarantees of ADR-0042/0061.
- **A proxy sidecar in the pod, holding the real provider key:** rejected — it places a long-lived secret inside the
  workload's own trust domain, which is the property this ADR exists to remove.
- **Plain subprocess runtimes:** rejected — same user, same filesystem, no boundary. A runtime is only a runtime when a
  primitive enforces it.
- **Keep `host` as a developer-only runtime:** rejected. It is the only configuration where commands, file tools, checks
  and the evidence a human approves all run as the operator, and it is reachable by one environment variable. It is also
  not a full substitute for a real runtime: `isolatesCandidate: false` means the diagnostic evidence path (ADR-0059,
  ADR-0067) cannot run on it at all.
- **Keep the isolation waiver as an environment variable:** rejected. The waiver is needed, but deciding it by how the
  process was started (a) weakens declared minimums for agents and checks alike, (b) leaves no reviewed record that the
  team accepted weaker isolation, and (c) cannot be seen by the human who approves the evidence. A profile field keeps
  one definition for every environment and makes the decision reviewable.
- **Status quo plus the P0 fixes only:** rejected as insufficient on its own — it closes the direct paths (and must
  still be done, see `docs/security.md` §7/P0), but the agent keeps running next to the credentials.

## Open questions

- How much of the tool loop to keep once S4 lands: fallback for runtimes without a primitive, or delete entirely.
- Whether the model proxy speaks every provider protocol family or normalizes to one dialect (affects which model
  parameters survive: reasoning, caching headers, multimodal input).
- What the minimum transcript-honesty guarantee should be: sequence numbers plus factory-observed calls, or signed
  batches from the runtime.
- Whether per-run runtimes with a warm cache volume are fast enough to keep the developer feedback loop usable.

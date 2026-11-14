# ADR-0035: Standalone, read-only Kubernetes CR MCP server

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** project owner
- **Extends:** ADR-0007, ADR-0034

## Context
Service desk investigation needs the observed state of controlplane custom resources, not just repository code.
The same capability must work in local harnesses without running the factory. Cluster credentials and Kubernetes
implementation details must stay outside the factory core.

## Decision
- Add `components/kubernetes-cr-mcp/`, an independently installable TypeScript/Node package with its own lockfile,
  tests and CLI. Use the official MCP and Kubernetes client SDKs. It imports nothing from `web/`.
  Its role-specific ports live inside the component, rather than `web/src/core/ports/`, to preserve independence.
  Component configuration uses its own validated schema; the factory resource validator excludes `components/`.
- Serve MCP over **stdio**. Expose only `discover_resources`, `list_resources`, `get_resource` and
  `get_resource_hierarchy`. No writes, shell tool, raw API paths, watches, or Kubernetes Secret access.
- A validated YAML catalog allowlists exact `apiVersion`, `kind`, plural and scope, and permitted namespaces.
  Discovery describes this configured catalog and its relationships; it does not enumerate every CRD in a cluster
  or claim that configured versions are installed. Namespaced reads always require a permitted namespace.
  Lists accept Kubernetes label selectors and bounded pagination, never an implicit all-namespace query.
- Relationships are directed references configured by a simple dotted field path (`*` traverses an array),
  targeting another configured CR type. References contain `name` and optionally `namespace` (otherwise the source
  namespace). The controlplane example follows Rover status references to applications, exposures and subscriptions,
  and their downstream objects. Hierarchy traversal is bounded, deduplicated and reports missing/forbidden nodes and
  truncation explicitly. It is not a reverse-reference or whole-cluster crawler.
- Kubeconfig is operator-owned, outside Git, selected by CLI (`--kubeconfig`, `--context`) or normal Kubernetes client
  defaults. Never pass credentials as tool arguments or expose them through discovery. Kubeconfig is trusted operator
  input: exec credential plugins may run processes. Use a dedicated `get`/`list`-only identity and namespace RBAC.
- Return metadata without annotations/managed fields, and spec/status with sensitive field names redacted recursively.
  Additional YAML `redactPaths` cover domain-specific fields. This is defense in depth, not a guarantee arbitrary CR
  text is secret-free; operators must audit allowed CR schemas. Kubernetes errors expose operation/status, not response
  bodies or credential diagnostics. stdout is reserved for MCP; startup diagnostics go to stderr.
- Integrate through an ordinary `ToolServer` and the support engineer's `toolServerRefs`; retain the existing host
  opt-in, tool allowlist, result redaction and transcript recording (ADR-0034). No factory core behavior changes.
  Missing local configuration/credentials is reported as an unavailable tool server, not simulated cluster evidence.

## Consequences
- One package works with the factory or any stdio MCP harness. Kubernetes is not an app runtime dependency.
- Operators install this component separately, configure namespaces/context, and provision least-privilege RBAC.
  The checked-in example contains CR identities/relationships only, never a cluster endpoint or credentials.
- AGENTS.md sections 3 and 4 gain the component and milestone X17. Architecture and glossary distinguish the
  external cluster CR catalog from the factory's own resource kinds.
- Initial scope is one cluster context per process and forward object-reference relationships. Other clusters,
  reverse label-based relationships, and mutations are not part of this increment.

## Alternatives considered
- Add Kubernetes tools directly to the factory: cannot be used independently and couples cluster credentials to the app.
- A generic kubectl/shell MCP server: broader authority than service desk investigation needs.
- Discover all installed CRDs automatically: needs wider permissions and bypasses the operator-curated catalog.
- HTTP transport first: adds a listener and authentication without helping the local-process use case.

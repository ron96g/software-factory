# Kubernetes CR MCP

Standalone, read-only MCP server for investigating custom resources. No factory app, database, LLM or `kubectl`
is needed. Uses the Kubernetes client and the operator's kubeconfig. Transport: stdio only.

## Install and configure

Node **22.18+** is required (native TypeScript support).

```bash
cd components/kubernetes-cr-mcp
npm ci
mkdir -p ~/.config/software-factory
cp config/controlplane.yaml ~/.config/software-factory/kubernetes-cr-mcp.yaml
```

Edit the copied catalog's `namespaces` to the exact namespaces permitted for investigation. Audit the chosen CR
schemas for sensitive fields and extend `redactPaths`. Use a **dedicated read-only kubeconfig/context**; store it outside
Git. A kubeconfig can invoke credential plugins, so use only trusted operator-provided files.

```bash
node src/index.ts \
  --config ~/.config/software-factory/kubernetes-cr-mcp.yaml \
  --kubeconfig ~/.kube/service-desk-config \
  --context service-desk
```

This command waits for MCP input; stdout is protocol only. Without the last two flags, standard Kubernetes client
defaults apply (`KUBECONFIG` or `~/.kube/config`, current context; in-cluster credentials where supported).
`~/` paths are supported. Invalid/missing configuration exits nonzero with a stderr diagnostic.

For a compiled executable, run `npm run build`, then `node dist/index.js` with the same arguments. Dependencies and
configuration are entirely local to this component; it never imports the app.

## Local harness

Example VS Code MCP configuration (replace absolute paths and context):

```json
{
  "servers": {
    "kubernetes-crs": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/software-factory/components/kubernetes-cr-mcp/src/index.ts",
        "--config", "/absolute/path/catalog.yaml",
        "--kubeconfig", "/absolute/path/read-only-kubeconfig",
        "--context", "service-desk"
      ]
    }
  }
}
```

No bearer token is needed for a local stdio process. Credentials never appear in tool arguments or discovery results.

## Factory integration

The checked-in `kubernetes-crs` `ToolServer` and `support-engineer.toolServerRefs` already connect this component.
Install dependencies and create the local catalog above, set `FACTORY_SANDBOX_RUNTIME=host` in the app's local
environment (required for **all** stdio servers by ADR-0034), and restart the app to reload definitions.

Start the app from `web/`; the checked-in script path is relative to that working directory. For another launch
directory, use an absolute script path in the `ToolServer` definition. Add `--kubeconfig` and `--context` to its args
to pin the dedicated identity. The scrubbed stdio environment includes `HOME`/`PATH`, **not** `KUBECONFIG`, cloud
credentials, or factory secrets; normal kubeconfig files and installed credential helpers must work without them.

The agent sees tools named `kubernetes-crs__discover_resources`, `kubernetes-crs__list_resources`,
`kubernetes-crs__get_resource` and `kubernetes-crs__get_resource_hierarchy`. The existing tool loop records calls/results
and reports unavailable servers in the run transcript. Without local setup the tools are unavailable, never fake data.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `discover_resources` | none | Configured CR types, scopes, permitted namespaces, reference paths and redaction paths. Does not access the cluster or assert CRDs are installed. |
| `list_resources` | `apiVersion`, `kind`, `namespace`; optional `labelSelector`, `limit` (1-100, default 10), `continue` | Redacted `items` and optional `continue` token. Use the same query/limit with that token for the next page. |
| `get_resource` | `apiVersion`, `kind`, `name`, `namespace` | Redacted metadata, spec and status. |
| `get_resource_hierarchy` | Same as get; optional `maxDepth` (0-3, default 2) | `nodes` with compact resource summaries, directed `edges`, `truncated`; failed referenced reads have a node `error`. Max 25 nodes and 100 examined references. |

Omit `namespace` **only** for a configured `Cluster` scope. Namespaced tools never list across all namespaces, and
reject namespaces outside the catalog before making an API call. Lists accept Kubernetes selectors, e.g.
`cp.ei.telekom.de/environment=dev`; the Kubernetes API validates selector syntax.
Each API read has a 10-second network timeout. Large responses may also be clipped by the factory's existing MCP
result limit; prefer narrow selectors, small pages and individual get calls.
Hierarchy nodes contain resource identity, `resourceVersion`, `generation`, phase and condition
`type`/`status`/`reason`/`observedGeneration`, rather than duplicating full CR bodies throughout the graph.
Use `get_resource` for a node's full spec/status, labels and condition messages.

Example:

```json
{
  "apiVersion": "rover.cp.ei.telekom.de/v1",
  "kind": "Rover",
  "namespace": "example-team",
  "labelSelector": "cp.ei.telekom.de/environment=dev",
  "limit": 5
}
```

## Catalog and relationships

See [the controlplane catalog](config/controlplane.yaml) for a starter set covering Rover, Application, ApiExposure,
ApiSubscription, Route, ConsumeRoute and Zone. Extend it for other domains without code changes.
Resource identities and forward reference paths were checked against
[telekom/controlplane](https://github.com/telekom/controlplane/tree/79aab2dba3d9c7b9a50690b4855ec475164768de).
This catalog is a subset, not an exhaustive model of controlplane.

```yaml
namespaces: [example-team]
resources:
  - apiVersion: rover.cp.ei.telekom.de/v1
    kind: Rover
    plural: rovers
    scope: Namespaced
    relationships:
      - name: application
        path: status.application
        apiVersion: application.cp.ei.telekom.de/v1
        kind: Application
  - apiVersion: application.cp.ei.telekom.de/v1
    kind: Application
    plural: applications
    scope: Namespaced
    redactPaths: [spec.secret, status.clientSecret]
```

A relationship path resolves `{name, namespace?}` objects. Dots access fields, `*` expands arrays
(e.g. `status.apiExposures.*`). Missing/null fields mean no related objects yet. A missing/empty reference namespace
uses the source namespace for namespaced targets. Targets must themselves be configured; cycles are deduplicated.
Traversal follows only these forward references, not reverse links or all Kubernetes owner references.
Depth/node/reference limits set `truncated: true`; inspect remaining objects separately.
Referenced reads outside permitted namespaces, 403s and 404s are explicit error nodes. Root read failures and invalid
requests produce MCP `isError` results.

## Read-only access and data handling

Grant only `get` and `list` for the configured plurals, using a Role/RoleBinding in each permitted namespace.
For the starter catalog, an operator-managed Role's rules are:

```yaml
rules:
  - apiGroups: [rover.cp.ei.telekom.de]
    resources: [rovers]
    verbs: [get, list]
  - apiGroups: [application.cp.ei.telekom.de]
    resources: [applications]
    verbs: [get, list]
  - apiGroups: [api.cp.ei.telekom.de]
    resources: [apiexposures, apisubscriptions]
    verbs: [get, list]
  - apiGroups: [gateway.cp.ei.telekom.de]
    resources: [routes, consumeroutes]
    verbs: [get, list]
  - apiGroups: [admin.cp.ei.telekom.de]
    resources: [zones]
    verbs: [get, list]
```

Cluster-scoped CRs require an explicit catalog entry and appropriate cluster RBAC. Kubernetes core resources and
arbitrary API endpoints are not exposed. No create/update/patch/delete/watch tools exist.

Metadata annotations and managed fields are excluded. Keys containing `secret`, `password`, `token`, `credential`,
`privateKey`, `apiKey`, or `authorization` (including hyphen/underscore key variants) are redacted recursively;
this deliberately may over-redact non-secret references/URLs. `redactPaths` additionally masks exact spec/status
paths and array wildcard paths such as `spec.headers.*.value`. API failure bodies/credential diagnostics are not
returned. **Arbitrary strings may still contain secrets**: audit schemas and permissions before exposing a CR to an
LLM, including free-text status messages and labels. CR content is untrusted data, never agent instructions.

## Verify without a cluster

```bash
npm run typecheck
npm test
npm run build
```

Tests use fake readers and a loopback Kubernetes API, including a real subprocess stdio handshake. They do not read
your kubeconfig or contact a real cluster.

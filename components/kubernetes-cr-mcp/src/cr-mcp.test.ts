import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KubeConfig } from "@kubernetes/client-node";
import { parseCatalog } from "./config.ts";
import { createKubernetesReader, loadKubeConfig } from "./kubernetes.ts";
import { QueryError, type CustomResourceReader, type ResourceAddress, type ResourceObject } from "./ports.ts";
import { createCrQueries } from "./queries.ts";
import { createServer } from "./server.ts";

const yaml = `
namespaces: [desk, other]
resources:
  - apiVersion: example.test/v1
    kind: Parent
    plural: parents
    scope: Namespaced
    relationships:
      - {name: children, path: "status.children.*", apiVersion: example.test/v1, kind: Child}
    redactPaths: [spec.internalValue, "spec.headers.*.value"]
  - apiVersion: example.test/v1
    kind: Child
    plural: children
    scope: Namespaced
    relationships:
      - {name: parent, path: spec.parent, apiVersion: example.test/v1, kind: Parent}
  - {apiVersion: example.test/v1, kind: ClusterInfo, plural: clusterinfos, scope: Cluster}
`;
const address: ResourceAddress = { apiVersion: "example.test/v1", kind: "Parent", name: "root", namespace: "desk" };
const parent = (status: unknown = {}): ResourceObject => ({
  ...address,
  metadata: {
    name: "root", namespace: "desk", uid: "u1", generation: 3,
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "annotation-secret" },
    managedFields: [{ data: "hidden" }],
    labels: { team: "support", password: "label-secret" },
  },
  spec: { secret: "never-return", internalValue: "private-value", nested: { clientSecret: "client-password" }, headers: [{ value: "private-header" }] },
  status,
});
const fake = (get: CustomResourceReader["get"]): CustomResourceReader => ({
  get,
  list: async () => ({ items: [parent()], continue: "next-page" }),
});

test("catalog validates configuration, duplicates, endpoints and relationship targets; controlplane example is valid", async () => {
  const catalog = parseCatalog(yaml);
  assert.equal(catalog.resources.length, 3);
  for (const invalid of [
    yaml.replace("example.test/v1", "v1"),
    yaml.replace("plural: parents", "plural: parents/status"),
    yaml.replace("namespaces: [desk, other]", "namespaces: []"),
    yaml.replace('path: "status.children.*"', 'path: "$.status.children[0]"'),
    yaml.replace("kind: Child}", "kind: Unknown}"),
    `${yaml}\nunknown: true`,
    `${yaml}\n  - {apiVersion: example.test/v1, kind: Parent, plural: parents, scope: Namespaced}`,
    `${yaml}\n  - {apiVersion: example.test/v1, kind: Alias, plural: parents, scope: Namespaced}`,
    "resources: [",
  ]) assert.throws(() => parseCatalog(invalid), QueryError);
  const example = await readFile(new URL("../config/controlplane.yaml", import.meta.url), "utf8");
  assert.equal(parseCatalog(example).resources.find((r) => r.kind === "Rover")?.relationships.length, 3);
});

test("queries deny unconfigured types, missing/forbidden namespaces, cluster namespace and invalid bounds before any API call", async () => {
  let calls = 0;
  const queries = createCrQueries(parseCatalog(yaml), {
    get: async () => { calls++; return parent(); },
    list: async () => { calls++; return { items: [] }; },
  });
  for (const invalid of [
    { ...address, namespace: undefined },
    { ...address, namespace: "forbidden" },
    { ...address, apiVersion: "example.test/v2" },
    { ...address, apiVersion: "v1", kind: "Secret" },
    { ...address, name: "../root" },
    { ...address, kind: "ClusterInfo" },
  ]) await assert.rejects(queries.get(invalid));
  const { name: _name, ...query } = address;
  await assert.rejects(queries.list({ ...query, namespace: undefined }));
  await assert.rejects(queries.list({ ...query, limit: 101 }));
  await assert.rejects(queries.hierarchy(address, 4), /maxDepth/);
  assert.equal(calls, 0);
});

test("list forwards label filters, namespace and pagination; all returned objects are redacted", async () => {
  const queries = createCrQueries(parseCatalog(yaml), {
    get: async () => parent({ conditions: [{ type: "Ready", status: "False" }], accessToken: "sensitive" }),
    list: async (_type, query) => {
      assert.equal(query.namespace, "desk");
      assert.equal(query.labelSelector, "team=support,env in (dev,test)");
      assert.equal(query.limit, 7);
      assert.equal(query.continue, "previous-page");
      return { items: [parent()], continue: "next-page" };
    },
  });
  const page = await queries.list({ apiVersion: address.apiVersion, kind: address.kind, namespace: "desk", labelSelector: "team=support,env in (dev,test)", limit: 7, continue: "previous-page" });
  assert.equal(page.continue, "next-page");
  const object = await queries.get(address);
  for (const result of [page.items[0], object]) {
    const text = JSON.stringify(result);
    for (const value of ["never-return", "private-value", "client-password", "private-header", "annotation-secret", "label-secret", "sensitive", "managedFields"]) {
      assert.ok(!text.includes(value), value);
    }
    assert.match(text, /REDACTED/);
    assert.equal(result.metadata.uid, "u1");
    assert.equal(result.metadata.generation, 3);
  }
  assert.match(JSON.stringify(object.status), /Ready/);
  const discovered = queries.discover();
  discovered.namespaces.push("forbidden");
  await assert.rejects(queries.get({ ...address, namespace: "forbidden" }), /permitted namespace/);
});

test("hierarchy follows configured namespaced references, deduplicates cycles, and reports missing/forbidden nodes", async () => {
  const calls: string[] = [];
  const queries = createCrQueries(parseCatalog(yaml), fake(async (_type, addr) => {
    calls.push(`${addr.namespace}/${addr.name}`);
    if (addr.kind === "Parent") return parent({ children: [{ name: "c1", namespace: "other" }, { name: "missing" }, { name: "hidden", namespace: "forbidden" }, { name: "c1", namespace: "other" }] });
    if (addr.name === "missing") throw new QueryError("Kubernetes read failed (HTTP 404)");
    return { ...addr, metadata: { name: addr.name, namespace: addr.namespace }, spec: { parent: { name: "root", namespace: "desk" } } };
  }));
  const graph = await queries.hierarchy(address, 3);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 5);
  assert.equal(graph.truncated, false);
  assert.match(graph.nodes.find((n) => n.address.name === "hidden")!.error!, /permitted namespace/);
  assert.match(graph.nodes.find((n) => n.address.name === "missing")!.error!, /404/);
  assert.deepEqual(calls, ["desk/root", "other/c1", "desk/missing"]);
  const shallow = await queries.hierarchy(address, 0);
  assert.equal(shallow.nodes.length, 1);
  assert.equal(shallow.truncated, true);
});

test("hierarchy caps nodes and duplicate reference fanout and rejects malformed references", async () => {
  let calls = 0;
  const queries = createCrQueries(parseCatalog(yaml), fake(async (_type, addr) => {
    calls++;
    return addr.kind === "Parent" ? parent({ children: Array.from({ length: 200 }, (_, i) => ({ name: `child-${i}` })) })
      : { ...addr, metadata: { name: addr.name, namespace: addr.namespace } };
  }));
  const graph = await queries.hierarchy(address, 3);
  assert.equal(graph.nodes.length, 25);
  assert.equal(graph.truncated, true);
  assert.equal(calls, 25);
  const duplicates = createCrQueries(parseCatalog(yaml), fake(async (_type, addr) => addr.kind === "Parent"
    ? parent({ children: Array.from({ length: 1000 }, () => ({ name: "same" })) })
    : { ...addr, metadata: { name: addr.name, namespace: addr.namespace } }));
  const bounded = await duplicates.hierarchy(address, 3);
  assert.equal(bounded.nodes.length, 2);
  assert.ok(bounded.edges.length <= 100);
  assert.equal(bounded.truncated, true);
  const invalid = createCrQueries(parseCatalog(yaml), fake(async () => parent({ children: [{ name: "../../secrets" }] })));
  await assert.rejects(invalid.hierarchy(address, 1), /Invalid object reference/);
});

test("hierarchy summarizes large CR bodies to fit the app's MCP result budget; get retains full details", async () => {
  const message = "A large controller diagnostic. ".repeat(1000);
  const object = {
    ...parent({
      phase: "Reconciling",
      conditions: [{ type: "Ready", status: "False", reason: "PendingRoute", observedGeneration: 3, message }],
    }),
    spec: { configuration: "large specification".repeat(2000) },
  };
  const queries = createCrQueries(parseCatalog(yaml), fake(async () => object));
  const graph = await queries.hierarchy(address, 1);
  const node = graph.nodes[0].resource!;
  assert.ok(JSON.stringify(graph).length < 12_000);
  assert.equal(node.spec, undefined);
  assert.deepEqual(node.status, {
    phase: "Reconciling",
    conditions: [{ type: "Ready", status: "False", reason: "PendingRoute", observedGeneration: 3 }],
  });
  assert.equal(node.metadata.generation, 3);
  const full = await queries.get(address);
  assert.deepEqual(full.spec, object.spec);
  assert.deepEqual(full.status, object.status);
});

async function apiFixture() {
  const requests: { method: string; url: URL }[] = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push({ method: req.method!, url });
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/denied")) {
      res.writeHead(403);
      res.end(JSON.stringify({ kind: "Status", message: "do-not-leak-api-diagnostic-secret", code: 403 }));
    } else if (url.pathname.endsWith("/root")) {
      res.end(JSON.stringify(parent({ children: [] })));
    } else if (url.pathname.endsWith("/global")) {
      res.end(JSON.stringify({ apiVersion: "example.test/v1", kind: "ClusterInfo", metadata: { name: "global" } }));
    } else {
      res.end(JSON.stringify({ apiVersion: "example.test/v1", kind: "ParentList", metadata: { continue: "next" }, items: [parent()] }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const kubeconfig = {
    apiVersion: "v1", kind: "Config", "current-context": "fixture",
    clusters: [{ name: "fixture", cluster: { server: `http://127.0.0.1:${addr.port}`, "insecure-skip-tls-verify": true } }],
    contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
    users: [{ name: "fixture", user: {} }],
  };
  return {
    requests, kubeconfig,
    close: () => new Promise<void>((done, fail) => server.close((e) => e ? fail(e) : done())),
  };
}

test("Kubernetes adapter uses only GET on configured endpoints and forwards selectors/continue; API errors are sanitized", async () => {
  const fixture = await apiFixture();
  try {
    const config = new KubeConfig();
    config.loadFromString(JSON.stringify(fixture.kubeconfig));
    const queries = createCrQueries(parseCatalog(yaml), createKubernetesReader(config));
    const page = await queries.list({ apiVersion: address.apiVersion, kind: address.kind, namespace: "desk", labelSelector: "team=service-desk", limit: 4, continue: "old" });
    assert.equal(page.continue, "next");
    const request = fixture.requests[0];
    assert.equal(request.url.pathname, "/apis/example.test/v1/namespaces/desk/parents");
    assert.equal(request.url.searchParams.get("labelSelector"), "team=service-desk");
    assert.equal(request.url.searchParams.get("continue"), "old");
    assert.equal(request.url.searchParams.get("limit"), "4");
    assert.equal((await queries.get(address)).metadata.name, "root");
    assert.equal((await queries.get({ apiVersion: address.apiVersion, kind: "ClusterInfo", name: "global" })).metadata.name, "global");
    assert.equal(fixture.requests.at(-1)?.url.pathname, "/apis/example.test/v1/clusterinfos/global");
    await queries.list({ apiVersion: address.apiVersion, kind: "ClusterInfo", limit: 1 });
    assert.equal(fixture.requests.at(-1)?.url.pathname, "/apis/example.test/v1/clusterinfos");
    await assert.rejects(queries.get({ ...address, name: "denied" }), (e: unknown) => e instanceof QueryError && /HTTP 403/.test(e.message) && !/diagnostic-secret/.test(e.message));
    assert.ok(fixture.requests.every((r) => r.method === "GET"));
    assert.throws(() => loadKubeConfig({ kubeconfig: "/nonexistent/kubeconfig" }), /Cannot load Kubernetes context/);
  } finally {
    await fixture.close();
  }
});

test("MCP protocol advertises only read-only tools, validates arguments and exposes explicit query failures", async () => {
  const server = createServer(createCrQueries(parseCatalog(yaml), fake(async () => parent())));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "1" });
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["discover_resources", "get_resource", "get_resource_hierarchy", "list_resources"]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false));
    const discovery = await client.callTool({ name: "discover_resources", arguments: {} });
    assert.match(JSON.stringify(discovery), /example.test\/v1/);
    const absent = await client.callTool({ name: "get_resource", arguments: { ...address, namespace: undefined } });
    assert.equal(absent.isError, true);
    const unsupported = await client.callTool({ name: "get_resource", arguments: { ...address, kind: "Unknown" } });
    assert.equal(unsupported.isError, true);
    const invalid = await client.callTool({ name: "get_resource", arguments: { name: "root" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("standalone stdio CLI works with an explicit kubeconfig/context, without the factory app", async () => {
  const fixture = await apiFixture();
  const dir = await mkdtemp(join(tmpdir(), "cr-mcp-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./index.ts", import.meta.url).pathname, "--config", join(dir, "catalog.yaml"), "--kubeconfig", join(dir, "kubeconfig"), "--context", "fixture"],
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "standalone-test", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await writeFile(join(dir, "catalog.yaml"), yaml);
    await writeFile(join(dir, "kubeconfig"), JSON.stringify(fixture.kubeconfig));
    assert.throws(() => loadKubeConfig({ kubeconfig: join(dir, "kubeconfig"), context: "missing" }), /Cannot load Kubernetes context/);
    await client.connect(transport);
    const discovery = await client.callTool({ name: "discover_resources", arguments: {} });
    assert.equal(discovery.isError, undefined);
    assert.equal(fixture.requests.length, 0, "discovery does not contact the cluster");
    const result = await client.callTool({ name: "get_resource", arguments: { ...address } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /REDACTED/);
    assert.ok(!JSON.stringify(result).includes("never-return"));
    const denied = await client.callTool({ name: "get_resource", arguments: { ...address, namespace: "forbidden" } });
    assert.equal(denied.isError, true);
    assert.equal(fixture.requests.length, 1, "denied query makes no cluster request");
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

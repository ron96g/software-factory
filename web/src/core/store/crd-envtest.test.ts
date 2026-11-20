import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";
import { GitDefinitionLoader } from "./definition-loader.ts";
import { CRD_GROUP, CRD_VERSION, DEFINITION_CRDS } from "./cr-mapper.ts";
import type { Resource } from "../model/resource.ts";

/**
 * AC-6: the generated CRDs are applied to a real kube-apiserver + etcd (the binaries `setup-envtest` installs).
 * Every definition in this repository must be accepted; the invalid samples must be rejected by schema or CEL.
 */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SAMPLES = join(REPO, "deploy/kubernetes/samples/invalid");

function assetsDir(): string | undefined {
  if (process.env.KUBEBUILDER_ASSETS) return process.env.KUBEBUILDER_ASSETS;
  const base = join(homedir(), ".local/share/kubebuilder-envtest/k8s");
  if (!existsSync(base)) return undefined;
  const latest = readdirSync(base).sort().pop();
  return latest ? join(base, latest) : undefined;
}

const assets = assetsDir();
const missing = !assets || !["etcd", "kube-apiserver", "kubectl"].every((b) => existsSync(join(assets, b)));
const skip = missing ? "envtest binaries missing: run `setup-envtest use -p path` and set KUBEBUILDER_ASSETS" : false;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const procs: ChildProcess[] = [];
let dir = "";
after(() => {
  for (const p of procs) p.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function kubectl(args: string[], input?: string, server = "") {
  return spawnSync(join(assets!, "kubectl"), [`--server=${server}`, "--token=envtest", "--insecure-skip-tls-verify", ...args], { input, encoding: "utf8" });
}

async function startCluster(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "envtest-"));
  const [client, peer, secure] = [await freePort(), await freePort(), await freePort()];
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  writeFileSync(join(dir, "sa.pub"), publicKey);
  writeFileSync(join(dir, "sa.key"), privateKey);
  writeFileSync(join(dir, "tokens.csv"), "envtest,admin,1,system:masters\n");
  const etcdUrl = `http://127.0.0.1:${client}`;
  procs.push(spawn(join(assets!, "etcd"), [`--data-dir=${join(dir, "etcd")}`, `--listen-client-urls=${etcdUrl}`, `--advertise-client-urls=${etcdUrl}`, `--listen-peer-urls=http://127.0.0.1:${peer}`], { stdio: "ignore" }));
  procs.push(
    spawn(join(assets!, "kube-apiserver"), [
      `--etcd-servers=${etcdUrl}`, `--secure-port=${secure}`, "--bind-address=127.0.0.1", `--cert-dir=${join(dir, "certs")}`,
      `--token-auth-file=${join(dir, "tokens.csv")}`, "--authorization-mode=AlwaysAllow", "--service-cluster-ip-range=10.0.0.0/24",
      "--service-account-issuer=https://envtest.local", `--service-account-key-file=${join(dir, "sa.pub")}`,
      `--service-account-signing-key-file=${join(dir, "sa.key")}`, "--disable-admission-plugins=ServiceAccount",
    ], { stdio: "ignore" }),
  );
  const server = `https://127.0.0.1:${secure}`;
  for (let i = 0; i < 120; i++) {
    if (kubectl(["get", "--raw=/readyz"], undefined, server).status === 0) return server;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("kube-apiserver did not become ready");
}

function toCr(r: Resource): Record<string, unknown> {
  const body = (r as Resource & { body?: string }).body;
  const spec = DEFINITION_CRDS[r.kind].document ? { ...(r.spec as object), body: body?.trim() || "-" } : r.spec;
  return { apiVersion: `${CRD_GROUP}/${CRD_VERSION}`, kind: r.kind, metadata: { name: r.metadata.name, namespace: "default" }, spec };
}

test("AC-6: envtest accepts the generated CRDs and every repository definition; invalid samples are rejected", { skip, timeout: 180_000 }, async () => {
  const server = await startCluster();
  const crds = readFileSync(join(REPO, "deploy/kubernetes/crds.yaml"), "utf8");
  const applied = kubectl(["apply", "-f", "-"], crds, server);
  assert.equal(applied.status, 0, applied.stderr);
  const established = kubectl(["wait", "--for=condition=Established", "--timeout=60s", "crd", "--all"], undefined, server);
  assert.equal(established.status, 0, established.stderr);

  const defs = (await new GitDefinitionLoader(REPO).load()).filter((r) => r.kind in DEFINITION_CRDS);
  assert.ok(defs.length > 10, "repository definitions loaded");
  const rejected = defs
    .map((r) => ({ r, res: kubectl(["apply", "--dry-run=server", "-f", "-"], stringify(toCr(r)), server) }))
    .filter(({ res }) => res.status !== 0)
    .map(({ r, res }) => `${r.kind}/${r.metadata.name}: ${res.stderr.trim()}`);
  assert.deepEqual(rejected, []);

  const invalid = readdirSync(SAMPLES).filter((f) => f.endsWith(".yaml")).sort();
  assert.ok(invalid.length >= 3);
  for (const f of invalid) {
    const text = readFileSync(join(SAMPLES, f), "utf8");
    const expected = /# expect: (.+)/.exec(text)?.[1].trim();
    assert.ok(expected && parseAllDocuments(text).length === 1, `${f} needs one document and '# expect:'`);
    const res = kubectl(["apply", "--dry-run=server", "-f", "-"], text, server);
    assert.notEqual(res.status, 0, `${f} must be rejected`);
    assert.match(res.stderr, new RegExp(expected!), `${f}: ${res.stderr}`);
  }
});

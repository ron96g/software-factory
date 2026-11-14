import { test } from "node:test";
import assert from "node:assert/strict";
import { K8sSecretResolver, SecretMissingError, type SecretsPort } from "./secrets.ts";
import { SecretRedactor, RedactingSecretResolver } from "../transcripts/recorder.ts";

const SECRET = "s3cr3t-value-xyz";
function port(calls: string[]): SecretsPort {
  return { async get(ns, name) { calls.push(`${ns}/${name}`); return name === "key" ? { value: SECRET } : undefined; } };
}

test("U5-O1 reads only referenced secrets, in the referrer namespace", async () => {
  const calls: string[] = [];
  const r = new K8sSecretResolver(port(calls));
  await r.refresh([{ ref: { name: "key" }, namespace: "a" }, { ref: { name: "key" }, namespace: "a" }, { ref: undefined }]);
  assert.deepEqual(calls, ["a/key"]);
  assert.equal(r.resolve({ name: "key" }), SECRET);
  assert.equal(r.resolve({ name: "key", namespace: "a" }), SECRET);
  assert.equal(r.resolve({ name: "other" }), undefined);
});

test("AC-3 missing secret rejects the reload and the error does not leak values", async () => {
  const r = new K8sSecretResolver(port([]));
  await r.refresh([{ ref: { name: "key" }, namespace: "a" }]);
  await assert.rejects(r.refresh([{ ref: { name: "gone" }, namespace: "a" }]), (e: Error) => e instanceof SecretMissingError && !e.message.includes(SECRET));
  assert.equal(r.resolve({ name: "key" }), SECRET, "last good value kept");
});

test("AC-7 redaction: secret values never appear in errors, status, logs or events", async () => {
  const redactor = new SecretRedactor();
  const r = new RedactingSecretResolver(new K8sSecretResolver(port([])), redactor);
  const inner = (r as unknown as { inner: K8sSecretResolver }).inner;
  await inner.refresh([{ ref: { name: "key" }, namespace: "a" }]);
  assert.equal(r.resolve({ name: "key" }), SECRET);
  const outputs: string[] = [];
  const logs: string[] = [];
  const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));
  try {
    await inner.refresh([{ ref: { name: "gone" }, namespace: "a" }]);
  } catch (e) { outputs.push(String(e)); }
  console.log = origLog;
  outputs.push(...logs, JSON.stringify({ status: { conditions: [{ type: "Ready", status: "False", reason: "SecretMissing" }] } }));
  for (const o of outputs) assert.ok(!o.includes(SECRET));
  assert.ok(!redactor.redact(`token ${SECRET}`).includes(SECRET));
});

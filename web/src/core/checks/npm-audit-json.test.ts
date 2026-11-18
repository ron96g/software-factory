import test from "node:test";
import assert from "node:assert/strict";
import { npmAuditJsonClassifier as c, registerCheckResultClassifiers } from "./classifiers.ts";
import { autoWaiveProblems } from "../model/auto-waive.ts";
import type { Repository } from "../model/kinds.ts";

const res = (stdout: string, exitCode = 1, extra = {}) => ({ stdout, stderr: "", exitCode, durationMs: 1, truncated: false, ...extra }) as never;
const audit = JSON.stringify({ vulnerabilities: { lodash: { name: "lodash", severity: "high", range: "<4.17.21", nodes: ["node_modules/lodash"],
  via: [{ source: 1234, name: "lodash", severity: "high", title: "Prototype pollution" }] } } });

test("AC-4: npm-audit-json reports findings with advisory+package+version+path+severity identity", () => {
  assert.equal(c.classify(res(audit)), "FindingsReported");
  assert.deepEqual(c.extractFindings(res(audit))?.map((f) => f.id), ["1234|lodash|<4.17.21|node_modules/lodash|high"]);
  assert.equal(c.classify(res("{}", 0)), "Passed");
});

test("AC-4: registry, network and parse errors are Unavailable and not comparable", () => {
  assert.equal(c.classify(res("not json")), "Unavailable");
  assert.equal(c.classify(res(JSON.stringify({ error: { code: "ENOTFOUND" } }))), "Unavailable");
  assert.equal(c.extractFindings(res("not json")), undefined);
  assert.equal(c.extractFindings(res(audit, 1, { truncated: true })), undefined);
});

test("AC-4: classifier is registered", () => {
  const seen: string[] = [];
  registerCheckResultClassifiers({ register: (k: string) => { seen.push(k); } } as never);
  assert.ok(seen.includes("npm-audit-json"));
});

test("AC-8: autoWaive entries must be in waivableChecks", () => {
  const repo = (autoWaive: unknown, waivableChecks: string[]) => ({ spec: { verification: { requiredChecks: [], preflightChecks: [], waivableChecks, autoWaive } } }) as unknown as Repository;
  assert.deepEqual(autoWaiveProblems(repo([{ check: "security-scan", when: "pre-existing" }], ["security-scan"])), []);
  assert.equal(autoWaiveProblems(repo([{ check: "build", when: "pre-existing" }], ["security-scan"])).length, 1);
  assert.equal(autoWaiveProblems(repo([{ check: "security-scan", when: "always" }], ["security-scan"])).length, 1);
});

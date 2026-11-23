import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxProfile } from "../model/kinds.ts";
import { decideIsolation } from "./sandbox-isolation.ts";

const health = (isolation: "none" | "process" | "container" | "microvm") => ({ runtime: "bwrap", available: true, isolation });
const profile = (isolation: "process" | "container" | "microvm", acceptWeakerIsolation?: boolean) =>
  ({ metadata: { name: "p" }, spec: { image: "", isolation, acceptWeakerIsolation } }) as SandboxProfile;

test("ADR-0080 §11: a runtime below the profile minimum is refused unless the profile accepts weaker isolation", () => {
  assert.throws(() => decideIsolation(health("process"), profile("container")), /acceptWeakerIsolation/);
  assert.deepEqual(decideIsolation(health("process"), profile("container", true)), { effective: "process", declared: "container", acceptedWeaker: true });
});

test("ADR-0080 §11: a runtime that meets the minimum is accepted without a waiver", () => {
  assert.deepEqual(decideIsolation(health("container"), profile("container")), { effective: "container", declared: "container", acceptedWeaker: false });
  assert.deepEqual(decideIsolation(health("microvm"), profile("container", true)), { effective: "microvm", declared: "container", acceptedWeaker: false });
});

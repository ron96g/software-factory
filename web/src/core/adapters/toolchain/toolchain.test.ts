import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SandboxProfile, ToolSpec } from "../../model/kinds.ts";
import { Registry } from "../../registry/registry.ts";
import type { ExecResult, ToolProvisioner, ToolchainContext } from "../../ports/index.ts";
import { COMMAND_TYPE, DefaultToolchain, GO_INSTALL_TYPE, commandProvisioner, goInstallProvisioner } from "./toolchain.ts";

const exec = (exitCode: number, stderr = ""): ExecResult => ({ exitCode, stdout: "", stderr, truncated: false, durationMs: 1, termination: { kind: "exit" } });

const tool = (name: string, provides: string, via: ToolSpec["via"]): ToolSpec => ({ name, provides, via });

/** A context whose `run` records commands and can be told to create the `provides` file (like a real install would). */
function context(dir: string, behaviour: (command: string) => ExecResult = () => exec(0)) {
  const commands: string[] = [];
  const ctx: ToolchainContext = {
    async run(command) {
      commands.push(command);
      const result = behaviour(command);
      if (result.exitCode === 0) writeFileSync(join(dir, "bin", "gotestsum"), "");
      return result;
    },
  };
  mkdirSync(join(dir, "bin"), { recursive: true });
  return { ctx, commands };
}

const profileOf = (...tools: ToolSpec[]): SandboxProfile =>
  ({ apiVersion: "v", kind: "SandboxProfile", metadata: { name: "p", namespace: "factory-system" }, spec: { image: "x", tools } }) as unknown as SandboxProfile;

test("ADR-0088: goInstall installs the module and refuses anything that is not `module@version`", async () => {
  const { ctx, commands } = context(mkdtempSync(join(tmpdir(), "sf-tools-")));
  const ok = await goInstallProvisioner.provision(tool("gotestsum", "bin/gotestsum", { type: GO_INSTALL_TYPE, with: { module: "gotest.tools/gotestsum@v1.13.0" } }), ctx);
  assert.deepEqual(ok, { installed: true });
  assert.deepEqual(commands, ["go install gotest.tools/gotestsum@v1.13.0"]);

  await assert.rejects(
    goInstallProvisioner.provision(tool("x", "bin/x", { type: GO_INSTALL_TYPE, with: { module: "gotest.tools/gotestsum; rm -rf /" } }), ctx),
    /goInstall needs with\.module/);
  await assert.rejects(goInstallProvisioner.provision(tool("x", "bin/x", { type: GO_INSTALL_TYPE }), ctx), /goInstall needs with\.module/);
});

test("ADR-0088: a failing provisioner reports why, with the output tail", async () => {
  const { ctx } = context(mkdtempSync(join(tmpdir(), "sf-tools-")), () => exec(1, "lookup proxy.golang.org: connection refused"));
  const result = await goInstallProvisioner.provision(tool("gotestsum", "bin/gotestsum", { type: GO_INSTALL_TYPE, with: { module: "m@v1" } }), ctx);
  assert.equal(result.installed, false);
  assert.match(result.message ?? "", /exit 1/);
  assert.match(result.message ?? "", /connection refused/);
});

test("ADR-0088: the command provisioner is the escape hatch for a tool no provisioner knows", async () => {
  const { ctx, commands } = context(mkdtempSync(join(tmpdir(), "sf-tools-")));
  const result = await commandProvisioner.provision(tool("gotestsum", "bin/gotestsum", { type: COMMAND_TYPE, with: { command: "make -C rover tools", timeoutMs: "1000" } }), ctx);
  assert.deepEqual(result, { installed: true });
  assert.deepEqual(commands, ["make -C rover tools"]);
  await assert.rejects(commandProvisioner.provision(tool("x", "bin/x", { type: COMMAND_TYPE, with: { command: "  " } }), ctx), /command needs with\.command/);
});

test("ADR-0088: status is a file check; ensure only runs a provisioner for a tool that is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-tools-"));
  const provisioner: ToolProvisioner = {
    type: "test",
    async provision(t, ctx) {
      await ctx.run("install it");
      writeFileSync(join(dir, t.provides), "");
      return { installed: true };
    },
  };
  const provisioners = new Registry<ToolProvisioner>();
  provisioners.register("test", provisioner);
  const toolchain = new DefaultToolchain({ dir, provisioners });
  const profile = profileOf(tool("a", "bin/a", { type: "test" }), tool("b", "bin/b", { type: "unknown" }));

  assert.deepEqual((await toolchain.status(profile)).map((o) => [o.name, o.state]), [["a", "missing"], ["b", "missing"]]);

  const { ctx, commands } = context(dir);
  const outcomes = await toolchain.ensure(profile, ctx);
  assert.deepEqual(outcomes.map((o) => o.state), ["installed", "failed"], "an unknown provisioner type fails visibly");
  assert.match(outcomes[1].message ?? "", /no provisioner is registered for type "unknown"/);
  assert.deepEqual(commands, ["install it"]);

  // A second ensure is a no-op for the tool that is now present.
  const again = await toolchain.ensure(profileOf(tool("a", "bin/a", { type: "test" })), ctx);
  assert.deepEqual(again.map((o) => o.state), ["ready"]);
  assert.deepEqual(commands, ["install it"], "a ready tool is not provisioned again");
});

test("ADR-0088: a provisioner that finishes without producing the tool is a failure, not a pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-tools-"));
  const silent: ToolProvisioner = { type: "silent", async provision() { return { installed: true }; } };
  const provisioners = new Registry<ToolProvisioner>();
  provisioners.register("silent", silent);
  const toolchain = new DefaultToolchain({ dir, provisioners });
  const outcomes = await toolchain.ensure(profileOf(tool("never", "bin/never", { type: "silent" })), context(dir).ctx);
  assert.deepEqual(outcomes.map((o) => o.state), ["failed"]);
  assert.match(outcomes[0].message ?? "", /provisioning finished but bin\/never is still missing/);
});

test("ADR-0088: two ensures of the same missing tool provision it once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-tools-"));
  let runs = 0;
  const slow: ToolProvisioner = {
    type: "slow",
    async provision(t, ctx) {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(join(dir, t.provides), "");
      return { installed: true };
    },
  };
  const provisioners = new Registry<ToolProvisioner>();
  provisioners.register("slow", slow);
  const toolchain = new DefaultToolchain({ dir, provisioners });
  const profile = profileOf(tool("a", "bin/a", { type: "slow" }));

  const [first, second] = await Promise.all([toolchain.ensure(profile, context(dir).ctx), toolchain.ensure(profile, context(dir).ctx)]);
  assert.equal(runs, 1, "concurrent prepares must not install the same tool twice");
  assert.deepEqual(first.map((o) => o.state), ["installed"]);
  assert.deepEqual(second.map((o) => o.state), ["installed"]);
});

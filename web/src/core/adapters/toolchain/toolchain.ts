import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SandboxProfile, ToolSpec } from "../../model/kinds.ts";
import type { Lookup, ToolProvisioner, Toolchain, ToolchainContext, ToolchainOutcome } from "../../ports/index.ts";
import { declaredTools } from "../../ports/index.ts";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** ADR-0088: installs any Go tool into the cache's `bin` (the sandbox sets `GOBIN` there). */
export const GO_INSTALL_TYPE = "goInstall";
const GO_MODULE = /^[A-Za-z0-9][A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const goInstallProvisioner: ToolProvisioner = {
  type: GO_INSTALL_TYPE,
  async provision(tool, ctx) {
    const module = tool.via.with?.module ?? "";
    if (!GO_MODULE.test(module)) throw new Error(`tool "${tool.name}": goInstall needs with.module "<module>@<version>", got "${module}"`);
    const result = await ctx.run(`go install ${module}`, { timeoutMs: timeoutOf(tool) });
    if (result.exitCode !== 0) return { installed: false, message: `go install ${module} failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}` };
    return { installed: true };
  },
};

/**
 * ADR-0088: the escape hatch for a tool no provisioner knows yet — a repo-authored command run in the sandbox with the
 * cache environment. It is still *declared* (named, with a `provides` file), so readiness stays observable.
 */
export const COMMAND_TYPE = "command";

export const commandProvisioner: ToolProvisioner = {
  type: COMMAND_TYPE,
  async provision(tool, ctx) {
    const command = tool.via.with?.command ?? "";
    if (!command.trim()) throw new Error(`tool "${tool.name}": command needs with.command`);
    const result = await ctx.run(command, { timeoutMs: timeoutOf(tool) });
    if (result.exitCode !== 0) return { installed: false, message: `"${command}" failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}` };
    return { installed: true };
  },
};

/** `via.with` is data: every parameter is a string, and `timeoutMs` (a decimal string) is the only optional one. */
const timeoutOf = (tool: ToolSpec): number => {
  const value = Number(tool.via.with?.timeoutMs);
  return Number.isSafeInteger(value) && value > 0 ? value : 600_000;
};

const tail = (text: string): string => text.trim().split("\n").slice(-6).join("\n");

/**
 * ADR-0088: the toolchain cache. Readiness is a `provides` file check, so `status` costs nothing and `ensure` only runs
 * a provisioner for a tool that is genuinely missing.
 */
export class DefaultToolchain implements Toolchain {
  private readonly dir: string;
  private readonly provisioners: Lookup<ToolProvisioner>;
  /** ADR-0088: one in-flight provisioning per tool, so two prepares cannot race on the same cache entry. */
  private readonly inFlight = new Map<string, Promise<ToolchainOutcome>>();
  constructor(o: { dir: string; provisioners: Lookup<ToolProvisioner> }) {
    this.dir = o.dir;
    this.provisioners = o.provisioners;
  }

  private fileOf(tool: ToolSpec): string {
    return join(this.dir, tool.provides);
  }

  async status(profile: SandboxProfile | undefined): Promise<ToolchainOutcome[]> {
    return declaredTools(profile).map((tool) => ({
      name: tool.name, type: tool.via.type, state: existsSync(this.fileOf(tool)) ? "ready" : "missing",
    }));
  }

  async ensure(profile: SandboxProfile | undefined, ctx: ToolchainContext): Promise<ToolchainOutcome[]> {
    return Promise.all(declaredTools(profile).map((tool) => this.ensureOne(tool, ctx)));
  }

  private async ensureOne(tool: ToolSpec, ctx: ToolchainContext): Promise<ToolchainOutcome> {
    const base = { name: tool.name, type: tool.via.type };
    if (existsSync(this.fileOf(tool))) return { ...base, state: "ready" };
    const key = `${this.dir}|${tool.name}|${tool.via.type}|${tool.provides}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.provisionOne(tool, ctx, base).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async provisionOne(tool: ToolSpec, ctx: ToolchainContext, base: { name: string; type: string }): Promise<ToolchainOutcome> {
    const provisioner = this.provisioners.get(tool.via.type);
    if (!provisioner) return { ...base, state: "failed", message: `no provisioner is registered for type "${tool.via.type}"` };
    try {
      const result = await provisioner.provision(tool, ctx);
      if (!existsSync(this.fileOf(tool))) {
        return { ...base, state: "failed", message: result.message ?? `provisioning finished but ${tool.provides} is still missing` };
      }
      return { ...base, state: "installed", ...(result.message ? { message: result.message } : {}) };
    } catch (error) {
      return { ...base, state: "failed", message: reason(error) };
    }
  }
}

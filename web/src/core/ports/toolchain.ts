import type { SandboxProfile, ToolSpec } from "../model/kinds.ts";
import type { ExecResult } from "./sandbox.ts";

/** ADR-0088: the fixed path the factory-owned toolchain cache is mounted at inside a sandbox. */
export const TOOLCHAIN_MOUNT = "/factory-tools";

/**
 * ADR-0088: what a provisioner installs into, and how it runs a command. A provisioner never knows how to spawn a
 * sandbox — it receives a `run` that executes inside one, with the cache environment already applied.
 */
export interface ToolchainContext {
  /**
   * Runs a command in a sandbox the factory controls, with the cache writable and its `bin` on `PATH` (ADR-0088 §5).
   * This is the only place the cache is writable: every check, agent shell and isolated snapshot sees it read-only, so a
   * candidate can never plant a binary another command would execute.
   */
  run(command: string, o?: { timeoutMs?: number }): Promise<ExecResult>;
}

/** What happened to one declared tool. */
export interface ToolchainOutcome {
  name: string;
  type: string;
  state: "ready" | "missing" | "installed" | "failed";
  message?: string;
}

/**
 * ADR-0088: provides one tool, selected by `via.type` (rule 4: registered, never a `switch`). The caller skips a tool
 * whose `provides` file already exists, so `provision` only runs when something is actually missing.
 */
export interface ToolProvisioner {
  readonly type: string;
  provision(tool: ToolSpec, ctx: ToolchainContext): Promise<{ installed: boolean; message?: string }>;
}

/** ADR-0088: ensures every tool a profile declares is present in the factory's toolchain cache. */
export interface Toolchain {
  /** Side-effect free: a `provides` file check per declared tool. */
  status(profile: SandboxProfile | undefined): Promise<ToolchainOutcome[]>;
  /** Installs what is missing. Idempotent and cheap when everything is ready. */
  ensure(profile: SandboxProfile | undefined, ctx: ToolchainContext): Promise<ToolchainOutcome[]>;
}

/** Tools of a profile, in declaration order. */
export const declaredTools = (profile: SandboxProfile | undefined): ToolSpec[] => profile?.spec.tools ?? [];

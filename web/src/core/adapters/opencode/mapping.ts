/**
 * ADR-0060: how factory definitions map onto OpenCode. Lookup tables keyed by the factory's own names, so adding a
 * provider type or tool is a new entry, not a branch.
 */

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

export const allowTool = (action: string): PermissionRule => ({ action, resource: "*", effect: "allow" });

/** OpenCode provider package and base URL per `ModelProvider.spec.type`; types without an entry are not supported. */
export const PROVIDER_PACKAGES: Readonly<Record<string, { package: string; baseURL: (configured?: string) => string }>> = {
  "openai-compatible": {
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: (b) => (b ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  },
  // The factory's Anthropic base URL has no version segment (the client appends /v1/messages); OpenCode expects it.
  anthropic: {
    package: "@opencode/ai/providers/anthropic",
    baseURL: (b) => `${(b ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1`,
  },
};

export interface BuiltinGroup {
  /** OpenCode tool names offered to the model. */
  tools: readonly string[];
  rules: readonly PermissionRule[];
  /** Changes the workspace: guarded and serialized like the tool loop's write/exec tools. */
  mutating: boolean;
}

const READ: BuiltinGroup = { tools: ["read", "glob", "grep"], rules: [allowTool("read"), allowTool("glob"), allowTool("grep")], mutating: false };
const WRITE: BuiltinGroup = { tools: ["edit", "write", "patch", "apply_patch"], rules: [allowTool("edit")], mutating: true };
const EXEC: BuiltinGroup = { tools: ["shell"], rules: [allowTool("shell")], mutating: true };

/** Factory tools that OpenCode's built-in tools replace (ADR-0060 §3); all other agent tools become plugin tools. */
export const BUILTIN_EQUIVALENTS: Readonly<Record<string, BuiltinGroup>> = {
  read_file: READ,
  list_files: READ,
  search_code: READ,
  write_file: WRITE,
  run: EXEC,
};

/** Every session gets skills and sub-agents (ADR-0060 §3). */
export const ALWAYS: BuiltinGroup = { tools: ["skill", "subagent"], rules: [allowTool("skill"), allowTool("subagent")], mutating: false };

/** Not offered to sub-agents: one level of delegation, and only the parent reports the result. */
export const PARENT_ONLY: ReadonlySet<string> = new Set(["subagent", "finish"]);

export const DENY_ALL: PermissionRule = { action: "*", resource: "*", effect: "deny" };

/** Appended last (the last matching rule wins): `.git` is never written, at any depth. */
export const PROTECTED: readonly PermissionRule[] = [".git", ".git/*", ".git/**", "**/.git", "**/.git/*", "**/.git/**"]
  .map((resource) => ({ action: "edit", resource, effect: "deny" as const }));

/** ADR-0020: only these variables reach commands; never factory secrets. */
export const SAFE_ENV: readonly string[] = ["PATH", "HOME", "LANG", "TERM", "USER"];

/** Provider failures that mean "wait", not "fail" (ADR-0031). */
export const UNAVAILABLE_STATUS: ReadonlySet<number> = new Set([429, 503, 529]);

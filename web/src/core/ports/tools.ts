/**
 * ADR-0034: tools across process boundaries (MCP), protocol-free. The MCP SDK lives in adapters only.
 */
import type { ToolServer } from "../model/kinds.ts";
import type { Principal } from "./app.ts";
import type { BoundTool } from "./integration.ts";

/** MCP tool annotations (hints for clients, e.g. to ask the user before destructive calls). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/**
 * An operation the factory offers to external agent harnesses (the factory's MCP server). Implementations call the
 * app commands, so the same rules apply as in the UI. Human gates are never exposed (rule 8).
 */
export interface ExposedTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments (type: object). */
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
  /** Never offered to factory agents calling back via MCP (rule 8), e.g. answering an item's own questions. */
  readonly humanOnly?: boolean;
  /** Returns a JSON-serializable result; throws for errors the client should see. */
  invoke(p: Principal, args: Record<string, unknown>): Promise<unknown>;
}

/** Tools from external MCP servers for one agent run. Close it when the run ends. */
export interface ToolSession {
  readonly tools: BoundTool[];
  /** Servers that could not be opened, with the reason (recorded, the run continues without them). */
  readonly unavailable: { server: string; reason: string }[];
  close(): Promise<void>;
}

/** Opens an agent's ToolServers (ADR-0011/0034). Tool names are `<server>__<tool>`, filtered by `allowedTools`. */
export interface ToolProvider {
  /** `runName` identifies the agent run to servers that care (the factory's own server hides human-only tools). */
  open(servers: ToolServer[], o: { allowStdio: boolean; runName?: string }): Promise<ToolSession>;
}

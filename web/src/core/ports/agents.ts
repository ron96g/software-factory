/**
 * Agent execution ports.
 *
 *   ExecutionContextFactory ─▶ ContextProvider* ─▶ PromptBuilder ─▶ AgentExecutor (chain) ─▶ AgentResult
 *
 * Executors form a Chain of Responsibility (LLM → built-in skill handlers → simulated).
 */
import type {
  Agent,
  AgentRun,
  Artifact,
  Clarification,
  Classification,
  Repository,
  Skill,
  WorkItem,
} from "../model/kinds.ts";
import type { TranscriptRecorder } from "./transcripts.ts";
import type { ResolvedModel } from "./integration.ts";
import type { SandboxHealthInfo } from "./sandbox.ts";
import type { RunProvenance } from "../model/kinds.ts";

/** A named block of context made available to the agent. */
export interface ContextSection {
  title: string;
  content: string;
  /** Who contributed it (provider name). */
  source: string;
}

export interface ExecutionContext {
  run: AgentRun;
  agent: Agent;
  /** Resolved skills, including transitive `requires`. */
  skills: Skill[];
  workItem: WorkItem;
  inputs: Artifact[];
  clarifications: Clarification[];
  repositories: Repository[];
  /** Filled by context providers. */
  sections: ContextSection[];
  /** ADR-0012: every executor MUST record its interaction here. */
  transcript: TranscriptRecorder;
  /** Resolved LLM for this run (ADR-0014); undefined when no provider is configured. */
  model?: ResolvedModel;
  /** Set for agents that need a sandbox (sandboxRef): the selected runtime's health (ADR-0019). */
  sandbox?: SandboxHealthInfo;
}

export interface ExecutionContextFactory {
  create(run: AgentRun): Promise<ExecutionContext>;
}

/** Enriches the context, e.g. with code-search hits or repository docs. */
export interface ContextProvider {
  readonly name: string;
  appliesTo(ctx: ExecutionContext): boolean;
  provide(ctx: ExecutionContext): Promise<ContextSection[]>;
}

export interface Prompt {
  system: string;
  user: string;
}

export interface PromptBuilder {
  /** `json`: answer with one JSON object; `tools`: work with tools and finish via the `finish` tool. */
  build(ctx: ExecutionContext, mode?: "json" | "tools"): Prompt;
}

export interface ProducedArtifact {
  /** ArtifactType name. */
  type: string;
  content: string;
  format?: string;
}

/** Uniform result of any executor. The controller interprets it. */
export interface AgentResult {
  summary?: string;
  artifacts?: ProducedArtifact[];
  classification?: Classification;
  /** Decision-gate outcome, e.g. "accept" | "needs-info". */
  outcome?: string;
  /** Non-empty → the work item gets blocked with a Clarification. */
  questions?: string[];
  /** Executor-specific provenance (model used, prompt hash); merged by the AgentRun controller. */
  provenance?: Partial<RunProvenance>;
}

export interface AgentExecutor {
  readonly name: string;
  canExecute(ctx: ExecutionContext): boolean;
  execute(ctx: ExecutionContext): Promise<AgentResult>;
}

/** Deterministic, non-LLM implementation of a single skill. */
export interface SkillHandler {
  /** Skill name it implements. */
  readonly skill: string;
  handle(ctx: ExecutionContext): Promise<AgentResult>;
}

export interface SkillHandlerLookup {
  get(skill: string): SkillHandler | undefined;
}

/** Lets an agent ask a delegate (e.g. code-researcher) a question. Creates a child AgentRun. */
export interface Delegator {
  delegate(parent: AgentRun, agentName: string, question: string): Promise<AgentResult>;
}

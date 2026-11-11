import type { KindInfo } from "../ports/index.ts";

export const BUILTIN_KINDS: KindInfo[] = [
  { kind: "Agent", plural: "agents", scope: "definition" },
  { kind: "Skill", plural: "skills", scope: "definition" },
  { kind: "Workflow", plural: "workflows", scope: "definition" },
  { kind: "ArtifactType", plural: "artifacttypes", scope: "definition" },
  { kind: "Source", plural: "sources", scope: "definition" },
  { kind: "Repository", plural: "repositories", scope: "definition" },
  { kind: "ModelProvider", plural: "modelproviders", scope: "definition" },
  { kind: "SandboxProfile", plural: "sandboxprofiles", scope: "definition" },
  { kind: "WorkItem", plural: "workitems", scope: "runtime" },
  { kind: "AgentRun", plural: "agentruns", scope: "runtime" },
  { kind: "Artifact", plural: "artifacts", scope: "runtime" },
  { kind: "Clarification", plural: "clarifications", scope: "runtime" },
  { kind: "Approval", plural: "approvals", scope: "runtime" },
  { kind: "Conversation", plural: "conversations", scope: "runtime" },
  { kind: "Event", plural: "events", scope: "runtime" },
  { kind: "OutboxMessage", plural: "outboxmessages", scope: "runtime" },
];

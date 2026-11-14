import { SYSTEM_NAMESPACE, type Ref, type Resource } from "../model/resource.ts";
import type { ResourceReader } from "../ports/index.ts";

/** Live `*Ref` field → target kind. Historical originWorkItemRef deliberately survives deletion (ADR-0039). */
export const REF_FIELDS: Record<string, string> = {
  agentRef: "Agent",
  skillRefs: "Skill",
  requires: "Skill",
  workflowRef: "Workflow",
  workflowRefs: "Workflow",
  artifactRef: "ArtifactType",
  artifactTypeRef: "ArtifactType",
  sourceRef: "Source",
  sourceRefs: "Source",
  repositoryRefs: "Repository",
  repositoryRef: "Repository",
  workspaceRef: "Workspace",
  providerRef: "ModelProvider",
  sandboxRef: "SandboxProfile",
  workItemRef: "WorkItem",
  agentRunRef: "AgentRun",
  parentRunRef: "AgentRun",
  knowledgeRef: "KnowledgeEntry",
  toolServerRefs: "ToolServer",
  conversationRef: "Conversation",
};

/** ADR-0011: same namespace first, then factory-system. Explicit namespace only for factory-system. */
export async function resolveRef<R extends Resource>(
  reader: ResourceReader,
  kind: string,
  ref: Ref,
  fromNamespace: string,
): Promise<R | null> {
  if (ref.namespace) {
    return ref.namespace === SYSTEM_NAMESPACE ? reader.get<R>(kind, SYSTEM_NAMESPACE, ref.name) : null;
  }
  return (await reader.get<R>(kind, fromNamespace, ref.name)) ?? (await reader.get<R>(kind, SYSTEM_NAMESPACE, ref.name));
}

export function* walkRefs(node: unknown, path = ""): Generator<{ field: string; ref: unknown; path: string }> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walkRefs(node[i], `${path}[${i}]`);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k in REF_FIELDS && v !== undefined && v !== null) {
        for (const ref of Array.isArray(v) ? v : [v]) yield { field: k, ref, path: `${path}.${k}` };
      }
      yield* walkRefs(v, `${path}.${k}`);
    }
  }
}

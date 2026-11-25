"use client";
import { Accordion } from "@mantine/core";
import type { WorkItemDetail } from "@/core/ports/app.ts";
import { MarkdownView } from "./markdown.tsx";
import { artifactMarkdown } from "./artifact-content.ts";

/** Artifacts produced by an evidence run, readable at the gate instead of only referenced by its summary. */
export function EvidenceArtifacts({ refs, artifacts }: { refs?: { name: string; role: "input" | "output" }[]; artifacts: WorkItemDetail["artifacts"] }) {
  const shown = (refs ?? []).flatMap((ref) => artifacts.filter((a) => a.metadata.name === ref.name).map((artifact) => ({ artifact, role: ref.role })));
  if (!shown.length) return null;
  return <Accordion variant="contained" multiple mt={4}>
    {shown.map(({ artifact, role }) => <Accordion.Item key={artifact.metadata.name} value={artifact.metadata.name}>
      <Accordion.Control>{role === "input" ? "Read by this agent" : "Produced"}: {artifact.spec.artifactTypeRef.name}</Accordion.Control>
      <Accordion.Panel>
        <MarkdownView>{artifactMarkdown(artifact) ?? (artifact.spec.format === "json" ? `\`\`\`json\n${pretty(artifact.spec.content)}\n\`\`\`` : artifact.spec.content)}</MarkdownView>
      </Accordion.Panel>
    </Accordion.Item>)}
  </Accordion>;
}

const pretty = (content: string) => {
  try { return JSON.stringify(JSON.parse(content), null, 2); }
  catch { return content; }
};

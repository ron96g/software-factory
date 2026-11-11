"use client";
import { Anchor, Badge, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import type { BrowsableKind } from "@/core/ports/app.ts";
import type { Resource } from "@/core/model/resource.ts";
import { useLive } from "@/ui/api.ts";
import { PhaseBadge, timeAgo } from "@/ui/badges.tsx";

/** Short, kind-aware summary column; everything else lives in the detail view. */
function summary(r: Resource): React.ReactNode {
  const s = (r.spec ?? {}) as Record<string, any>;
  const st = (r.status ?? {}) as Record<string, any>;
  switch (r.kind) {
    case "Agent":
      return `${s.role}${s.tools?.length ? ` · tools: ${s.tools.join(", ")}` : ""}`;
    case "Skill":
    case "ArtifactType":
      return s.description;
    case "Workflow":
      return (s.phases ?? []).map((p: any) => `${p.name} (${p.stages.length})`).join(" → ");
    case "Source":
      return `${s.type}${s.connection?.repo ? ` · ${s.connection.repo}` : s.connection?.url ? ` · ${s.connection.url}` : ""}`;
    case "Repository":
      return s.local?.path ? `local: ${s.local.path}` : s.git?.url;
    case "ModelProvider":
      return `${s.type} · ${Object.entries(s.models ?? {}).map(([t, m]) => `${t}=${m}`).join(", ")}${s.default ? " · default" : ""}`;
    case "SandboxProfile":
      return `${s.image} · isolation ${s.isolation ?? "container"}`;
    case "Workspace":
      return `${s.repositoryRef?.name} · ${s.branch}${st.baseCommit ? ` @ ${String(st.baseCommit).slice(0, 10)}` : ""}`;
    case "AgentRun":
      return `${s.agentRef?.name} · ${s.stage}/${s.step} · ${st.provenance?.executor ?? ""}`;
    default:
      return st.message ?? "";
  }
}

export default function ResourceList({ params }: { params: Promise<{ plural: string }> }) {
  const { plural } = use(params);
  const router = useRouter();
  const { data: kinds } = useLive<BrowsableKind[]>("/api/resources", () => false);
  const info = kinds?.find((k) => k.plural === plural);
  const { data, error } = useLive<Resource[]>(`/api/resources/${plural}`, (n) => n.kind === info?.kind);
  const href = (r: Resource) => (r.kind === "WorkItem" ? `/items/${r.metadata.name}` : `/resources/${plural}/${r.metadata.name}`);

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{info?.kind ?? plural}</Title>
          <Text c="dimmed" size="sm">
            {info?.scope === "definition" ? "Definition (from Git, read-only at runtime)" : "Runtime resource"} · {data?.length ?? "…"} item(s)
          </Text>
        </div>
      </Group>
      {error && <Text c="red">{error}</Text>}
      <Card className="sf-surface" p={0}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Summary</Table.Th>
              {info?.scope === "runtime" && <Table.Th>Phase</Table.Th>}
              <Table.Th>{info?.scope === "runtime" ? "Created" : "Version"}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(data ?? []).map((r) => (
              <Table.Tr key={`${r.metadata.namespace}/${r.metadata.name}`} className="sf-row" onClick={() => router.push(href(r))}>
                <Table.Td>
                  <Anchor component={Link} href={href(r)} size="sm" fw={500} onClick={(e) => e.stopPropagation()}>
                    {r.metadata.name}
                  </Anchor>
                  {r.metadata.namespace && r.metadata.namespace !== "default" && (
                    <Badge size="xs" variant="outline" color="gray" ml={6}>
                      {r.metadata.namespace}
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed" lineClamp={2}>
                    {summary(r)}
                  </Text>
                </Table.Td>
                {info?.scope === "runtime" && (
                  <Table.Td>{(r.status as { phase?: string } | undefined)?.phase && <PhaseBadge phase={(r.status as { phase: string }).phase} size="xs" />}</Table.Td>
                )}
                <Table.Td>
                  <Text size="xs" c="dimmed" ff={info?.scope === "runtime" ? undefined : "monospace"}>
                    {info?.scope === "runtime" ? timeAgo(r.metadata.creationTimestamp) : r.metadata.resourceVersion}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}

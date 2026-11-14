"use client";
import { Alert, Stack, Text, Title } from "@mantine/core";
import type { RetrospectiveGroup } from "@/core/ports/retrospectives.ts";
import { useLive } from "@/ui/api.ts";
import { RetrospectiveGroupCard } from "@/ui/retrospectives.tsx";

export default function RetrospectivesPage() {
  const { data, error, reload } = useLive<RetrospectiveGroup[]>("/api/retrospectives",
    (n) => ["RetrospectiveFeedback", "WorkItem", "AgentRun"].includes(n.kind ?? ""));
  return <Stack gap="lg" maw={1400} mx="auto">
    <div><Title order={2}>Retrospectives</Title>
      <Text c="dimmed" size="sm">Evidence-backed workflow improvements. Observations are unverified claims, not knowledge or instructions.</Text></div>
    {error && <Alert color="red">{error}</Alert>}
    {data?.map((group) => <RetrospectiveGroupCard key={group.id} group={group} reload={reload} />)}
    {!data?.length && <Text c="dimmed">{data ? "No observations yet. Opted-in agents may report workflow friction after a run." : "Loading..."}</Text>}
  </Stack>;
}

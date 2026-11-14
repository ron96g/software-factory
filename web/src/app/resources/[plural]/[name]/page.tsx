"use client";
import { Anchor, Badge, Button, Card, Code, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import { IconChevronLeft } from "@tabler/icons-react";
import Link from "next/link";
import { use } from "react";
import { useRouter } from "next/navigation";
import { stringify } from "yaml";
import type { Resource } from "@/core/model/resource.ts";
import { act, useLive } from "@/ui/api.ts";
import type { Conversation } from "@/core/model/kinds.ts";
import { PhaseBadge } from "@/ui/badges.tsx";
import { MarkdownView } from "@/ui/markdown.tsx";

export default function ResourceDetail({ params }: { params: Promise<{ plural: string; name: string }> }) {
  const { plural, name } = use(params);
  const router = useRouter();
  const { data: chatAgents } = useLive<{ metadata: { name: string } }[]>(plural === "agents" ? "/api/chats/agents" : null, () => false);
  const { data: r, error } = useLive<Resource & { body?: string }>(`/api/resources/${plural}/${name}`, (n) => n.name === name);
  if (error) return <Text c="red">{error}</Text>;
  if (!r) return <Text c="dimmed">Loading…</Text>;
  const { body, ...doc } = r;
  const phase = (r.status as { phase?: string } | undefined)?.phase;
  const workItem = r.metadata.ownerReferences?.find((o) => o.kind === "WorkItem")?.name;
  return (
    <Stack gap="lg" maw={1200} mx="auto">
      <Anchor component={Link} href={`/resources/${plural}`} size="sm">
        <Group gap={4}>
          <IconChevronLeft size={14} /> {r.kind}
        </Group>
      </Anchor>
      <Group gap="sm">
        <Title order={2}>{r.metadata.name}</Title>
        <Badge variant="light">{r.kind}</Badge>
        {phase && <PhaseBadge phase={phase} />}
        {r.kind === "Agent" && chatAgents?.some((a) => a.metadata.name === name) && (
          <Button variant="light" onClick={async () => {
            const c = await act<Conversation>("/api/chats", { agent: name });
            if (c) router.push(`/chats/${c.metadata.name}`);
          }}>Start chat</Button>
        )}
        {workItem && (
          <Anchor component={Link} href={`/items/${workItem}`} size="sm">
            work item: {workItem}
          </Anchor>
        )}
      </Group>
      <Card className="sf-surface">
        <Tabs defaultValue={body ? "body" : "yaml"}>
          <Tabs.List>
            {body && <Tabs.Tab value="body">Prompt / body</Tabs.Tab>}
            <Tabs.Tab value="yaml">YAML</Tabs.Tab>
          </Tabs.List>
          {body && (
            <Tabs.Panel value="body" pt="md">
              <MarkdownView>{body}</MarkdownView>
            </Tabs.Panel>
          )}
          <Tabs.Panel value="yaml" pt="md">
            <Code block>{stringify(doc)}</Code>
          </Tabs.Panel>
        </Tabs>
      </Card>
    </Stack>
  );
}

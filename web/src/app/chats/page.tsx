"use client";
import { Alert, Anchor, Badge, Card, Stack, Table, Text, Title } from "@mantine/core";
import Link from "next/link";
import type { Conversation } from "@/core/model/kinds.ts";
import { useLive } from "@/ui/api.ts";
import { timeAgo } from "@/ui/badges.tsx";
import { StartAgentChat } from "@/ui/start-agent-chat.tsx";

export default function ChatsPage() {
  const { data: chats, error } = useLive<Conversation[]>("/api/chats", (n) => n.kind === "Conversation");
  return (
    <Stack gap="lg" maw={1200} mx="auto">
      <Title order={2}>Agent chats</Title>
      <Text c="dimmed">Investigate with an agent, optionally using an existing work item's evidence. Read-only tools; chats never advance workflows.</Text>
      {error && <Alert color="red">{error}</Alert>}
      <StartAgentChat />
      <Card className="sf-surface">
        <Table>
          <Table.Thead><Table.Tr><Table.Th>Conversation</Table.Th><Table.Th>Agent</Table.Th><Table.Th>Work item context</Table.Th><Table.Th>State</Table.Th><Table.Th>Updated</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {(chats ?? []).map((c) => (
              <Table.Tr key={c.metadata.name}>
                <Table.Td><Anchor component={Link} href={`/chats/${c.metadata.name}`}>{c.spec.title || c.metadata.name}</Anchor></Table.Td>
                <Table.Td>{c.spec.agentRef?.name}</Table.Td>
                <Table.Td>{c.spec.workItemRef ? <Anchor component={Link} href={`/items/${c.spec.workItemRef.name}`} size="sm">{c.spec.workItemRef.name}</Anchor> : <Text size="sm" c="dimmed">None</Text>}</Table.Td>
                <Table.Td><Badge variant="light">{c.spec.turn && c.status?.activeTurn !== c.spec.turn.id ? "Queued" : c.status?.phase || "Ready"}</Badge></Table.Td>
                <Table.Td>{timeAgo(c.status?.lastMessageAt ?? c.metadata.creationTimestamp)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {chats?.length === 0 && <Text py="md" c="dimmed">No conversations yet.</Text>}
      </Card>
    </Stack>
  );
}

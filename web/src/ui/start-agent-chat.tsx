"use client";
import { Alert, Button, Group, Select, Stack, Text } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Agent, Conversation, WorkItem } from "@/core/model/kinds.ts";
import { act, useLive } from "./api.ts";

export function StartAgentChat({ workItemName }: { workItemName?: string }) {
  const router = useRouter();
  const { data: agents, error: agentsError } = useLive<Agent[]>("/api/chats/agents", () => false);
  const { data: items, error: itemsError } = useLive<WorkItem[]>(workItemName ? null : "/api/workitems", (n) => n.kind === "WorkItem");
  const [picked, setPicked] = useState<string | null>(null);
  const [item, setItem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const agent = picked ?? agents?.[0]?.metadata.name ?? null;
  return (
    <Stack gap="sm">
      {(agentsError || itemsError) && <Alert color="red">{agentsError || itemsError}</Alert>}
      <Group align="flex-end">
        <Select label="Agent" data={(agents ?? []).map((a) => a.metadata.name)} value={agent} onChange={setPicked} allowDeselect={false} disabled={starting} />
        {!workItemName && <Select
          label="Work item context (optional)"
          placeholder="No work item"
          data={(items ?? []).map((w) => ({ value: w.metadata.name, label: `${w.spec.title} (${w.metadata.name})` }))}
          value={item} onChange={setItem} searchable clearable disabled={!items || starting}
          style={{ flex: 1, minWidth: 240 }}
        />}
        <Button loading={starting} disabled={!agent} onClick={async () => {
          setStarting(true);
          const c = await act<Conversation>("/api/chats", { agent, workItem: workItemName ?? item ?? undefined });
          setStarting(false);
          if (c) router.push(`/chats/${c.metadata.name}`);
        }}>Start chat</Button>
      </Group>
      {agents?.length === 0 && <Text c="dimmed">No agents are enabled for direct chat.</Text>}
    </Stack>
  );
}

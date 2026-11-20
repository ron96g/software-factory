"use client";

import { Alert, Anchor, Badge, Button, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconGitPullRequest, IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import type { PublishedPullRequest, WorkItemDetail } from "@/core/ports/app.ts";
import { act, api } from "./api.ts";

/**
 * ADR-0054: published pull requests go stale when the base branch moves on. Checking compares them with the current
 * base; updating re-publishes from the publish stage, where conflicts are merged and resolved before the push.
 */
export function PullRequestPanel({ d }: { d: WorkItemDetail }) {
  const name = d.workItem.metadata.name;
  const published = d.outbox.some((m) => m.spec.action === "open-pull-request" && typeof m.status?.result?.url === "string");
  const [status, setStatus] = useState<PublishedPullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const check = async () => {
    setChecking(true);
    setError(null);
    try { setStatus(await api<PublishedPullRequest[]>(`/api/workitems/${name}/pull-requests`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  };
  const update = async () => {
    setUpdating(true);
    if (await act(`/api/workitems/${name}/pull-requests`, {}, "Updating the pull request from the publish stage")) setStatus(null);
    setUpdating(false);
  };
  const conflicting = status?.filter((pr) => pr.conflicts.length) ?? [];
  if (!published) return null;
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Group gap="xs"><IconGitPullRequest size={18} /><Text fw={600}>Pull request</Text></Group>
          <Text size="sm" c="dimmed">
            Other work may change the base branch after publication. Updating re-publishes from the publish stage: the latest base is merged,
            conflicts go to the developer agent, and the changed candidate passes review and verification again before it is pushed to the same pull request.
          </Text>
        </Stack>
        <Group gap="xs" wrap="nowrap">
          <Button variant="default" loading={checking} onClick={() => void check()}>Check for conflicts</Button>
          <Button leftSection={<IconRefresh size={16} />} loading={updating} onClick={() => void update()}>Update pull request</Button>
        </Group>
      </Group>
      {error && <Alert mt="sm" color="red" title="Could not check the pull request">{error}</Alert>}
      {status && (
        <Stack gap={4} mt="sm">
          {status.map((pr) => (
            <Group key={pr.url} gap="xs">
              <Anchor href={pr.url} target="_blank" rel="noopener noreferrer">{pr.repository} #{pr.number}</Anchor>
              {pr.error ? <Badge color="gray" variant="light">{pr.error}</Badge>
                : pr.conflicts.length ? <Tooltip label={pr.conflicts.join(", ")}><Badge color="red" variant="light">Conflicts with {pr.base}: {pr.conflicts.length} file(s)</Badge></Tooltip>
                : <Badge color="teal" variant="light">Merges cleanly into {pr.base}</Badge>}
            </Group>
          ))}
          {conflicting.length > 0 && <Text size="sm">Use <strong>Update pull request</strong> to resolve the conflicts.</Text>}
        </Stack>
      )}
    </Card>
  );
}

"use client";
import { Badge, Group, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { SourceChange, SourceComment, SourceHistory } from "@/core/model/kinds.ts";
import { FACTORY_COMMENT_MARKER } from "@/core/ports/integration.ts";

type Filter = "all" | "comments" | "changes";
type Entry = { at: string; comment?: SourceComment; change?: SourceChange };

const when = (iso: string) => new Date(iso).toLocaleString();

/** The source ticket's comments and field changes, oldest first, as agents see them (ADR-0070). */
export function TicketHistory({ history, externalId, url }: { history: SourceHistory; externalId?: string; url?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const entries = useMemo(
    (): Entry[] =>
      [
        ...(filter !== "changes" ? history.comments.map((c) => ({ at: c.createdAt, comment: c })) : []),
        ...(filter !== "comments" ? history.changes.map((c) => ({ at: c.at, change: c })) : []),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [history, filter],
  );
  const internal = history.comments.filter((c) => c.visibility === "internal").length;
  const omitted = (history.omitted?.comments ?? 0) + (history.omitted?.changes ?? 0);

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          {history.comments.length} comment(s){internal ? ` (${internal} internal)` : ""} · {history.changes.length} change(s) from{" "}
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {externalId ?? "the ticket"}
            </a>
          ) : (
            externalId ?? "the ticket"
          )}{" "}
          · fetched {when(history.fetchedAt)}
          {omitted ? ` · ${omitted} older entr${omitted === 1 ? "y" : "ies"} not stored` : ""}
        </Text>
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: "all", label: "All" },
            { value: "comments", label: "Comments" },
            { value: "changes", label: "Changes" },
          ]}
        />
      </Group>
      {internal > 0 && (
        <Text size="xs" c="orange">
          Internal comments are visible to the service-desk team only. Agents are told never to reveal them to the requester.
        </Text>
      )}
      {entries.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing here yet.
        </Text>
      )}
      {entries.map((e, i) =>
        e.comment ? (
          <Paper key={`c-${e.comment.id}-${i}`} withBorder p="sm" radius="sm" style={e.comment.visibility === "internal" ? { borderLeft: "3px solid var(--mantine-color-orange-6)" } : undefined}>
            <Group gap={6} mb={4} wrap="wrap">
              <Text size="sm" fw={600}>
                {e.comment.author}
              </Text>
              <Text size="xs" c="dimmed">
                {when(e.comment.createdAt)}
                {e.comment.updatedAt ? ` · edited ${when(e.comment.updatedAt)}` : ""}
              </Text>
              {e.comment.visibility === "internal" ? (
                <Badge size="xs" color="orange" variant="light">
                  internal
                </Badge>
              ) : (
                <Badge size="xs" color="teal" variant="light">
                  public
                </Badge>
              )}
              {e.comment.byFactory && (
                <Badge size="xs" color="gray" variant="light">
                  factory
                </Badge>
              )}
            </Group>
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {e.comment.body.split(FACTORY_COMMENT_MARKER).join("").trim() || "(empty)"}
            </Text>
          </Paper>
        ) : (
          <Group key={`h-${i}`} gap={6} wrap="nowrap" px="sm">
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {when(e.change!.at)}
            </Text>
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
              <b>{e.change!.author}</b> changed <b>{e.change!.field}</b>: {e.change!.from ?? "∅"} <IconArrowRight size={10} /> {e.change!.to ?? "∅"}
            </Text>
          </Group>
        ),
      )}
    </Stack>
  );
}

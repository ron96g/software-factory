"use client";
import {
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  MultiSelect,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCloudDownload, IconPlus, IconAlertTriangle, IconFileDescription } from "@tabler/icons-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Source, WorkItem } from "@/core/model/kinds.ts";
import type { NewItemOptions } from "@/core/ports/app.ts";
import { act, useLive } from "@/ui/api.ts";
import { issueNeedsReview } from "@/ui/issue-proposals.tsx";
import { STORY_WORKFLOW } from "@/ui/new-item.ts";
import type { IssueProposal } from "@/core/model/kinds.ts";
import { PhaseBadge, TypeBadge, timeAgo } from "@/ui/badges.tsx";

const FILTERS = { all: "All", attention: "Needs you", active: "Active", done: "Done" } as const;

export default function Dashboard() {
  const router = useRouter();
  const { data: items } = useLive<WorkItem[]>("/api/workitems", (n) => n.kind === "WorkItem");
  const { data: sources } = useLive<Source[]>("/api/sources", () => false);
  const { data: issues } = useLive<IssueProposal[]>("/api/issues", (n) => n.kind === "IssueProposal");
  const awaitingIssues = (issues ?? []).filter(issueNeedsReview).length;
  const [opened, { open, close }] = useDisclosure(false);
  const [initialWorkflow, setInitialWorkflow] = useState<string | undefined>();
  const openWith = (workflow?: string) => { setInitialWorkflow(workflow); open(); };
  useEffect(() => {
    // `/?new=<workflow>` (e.g. the Issues page's New ticket) opens New item with that workflow preselected.
    const wanted = new URLSearchParams(window.location.search).get("new");
    if (wanted) { openWith(wanted); window.history.replaceState(null, "", "/"); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");

  const rows = useMemo(() => {
    const all = items ?? [];
    const phase = (w: WorkItem) => w.status?.phase ?? "New";
    if (filter === "attention") return all.filter((w) => ["Blocked", "AwaitingApproval"].includes(phase(w)));
    if (filter === "active") return all.filter((w) => ["New", "Running", "Waiting"].includes(phase(w)));
    if (filter === "done") return all.filter((w) => ["Done", "Closed", "Failed"].includes(phase(w)));
    return all;
  }, [items, filter]);

  const attention = (items ?? []).filter((w) => ["Blocked", "AwaitingApproval"].includes(w.status?.phase ?? "")).length;
  const syncable = (sources ?? []).filter((s) => s.spec.type !== "manual" && s.spec.type !== "internal");

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>
            Work items
          </Title>
          {awaitingIssues > 0 && (
            <Badge component={Link} href="/resources/issueproposals" color="yellow" variant="light" mt={4} style={{ cursor: "pointer" }}>
              {awaitingIssues} issue {awaitingIssues === 1 ? "proposal" : "proposals"} awaiting review
            </Badge>
          )}
          <Text c="dimmed" size="sm">
            Every item flows through the AI-DLC loop. Humans approve at the gates.
          </Text>
        </div>
        <Group>
          <Menu position="bottom-end">
            <Menu.Target>
              <Button variant="default" leftSection={<IconCloudDownload size={16} />}>
                Sync
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {syncable.length === 0 && <Menu.Item disabled>No syncable sources</Menu.Item>}
              {syncable.map((s) => (
                <Menu.Item
                  key={s.metadata.name}
                  onClick={async () => {
                    const r = await act<{ created: number; updated: number }>(`/api/sources/${s.metadata.name}/sync`, {});
                    if (r) notifications.show({ message: `${s.metadata.name}: ${r.created} new, ${r.updated} updated`, color: "teal" });
                  }}
                >
                  {s.metadata.name} <Text span size="xs" c="dimmed">({s.spec.type})</Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button variant="light" leftSection={<IconFileDescription size={16} />} onClick={() => openWith(STORY_WORKFLOW)}>
            New ticket
          </Button>
          <Button leftSection={<IconPlus size={16} />} onClick={() => openWith()}>
            New item
          </Button>
        </Group>
      </Group>

      <Group justify="space-between">
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as keyof typeof FILTERS)}
          data={Object.entries(FILTERS).map(([value, label]) => ({ value, label: value === "attention" && attention ? `${label} (${attention})` : label }))}
        />
        <Text size="sm" c="dimmed">
          {rows.length} item(s)
        </Text>
      </Group>

      <Card className="sf-surface" p={0}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th>Type / Priority</Table.Th>
              <Table.Th>Repositories</Table.Th>
              <Table.Th>Stage</Table.Th>
              <Table.Th>Phase</Table.Th>
              <Table.Th>Created</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((w) => (
              <Table.Tr key={w.metadata.name} className="sf-row" onClick={() => router.push(`/items/${w.metadata.name}`)}>
                <Table.Td>
                  <Text fw={500}>{w.spec.title}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {w.metadata.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{w.spec.sourceRef.name}</Text>
                  {w.spec.externalRef && (
                    <Text size="xs" c="dimmed">
                      #{w.spec.externalRef.id}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <TypeBadge type={w.status?.classification?.type} />
                    {w.status?.classification?.priority && <Text size="xs">{w.status.classification.priority}</Text>}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {(w.spec.repositoryRefs ?? []).map((r) => r.name).join(", ")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{w.status?.stage ?? "–"}</Text>
                  <Text size="xs" c="dimmed">
                    {[w.spec.workflowRef?.name, w.status?.lifecyclePhase].filter(Boolean).join(" · ")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <PhaseBadge phase={w.status?.phase} />
                    {w.status?.phase === "Failed" && (
                      <Tooltip label={w.status.message}>
                        <IconAlertTriangle size={14} color="var(--mantine-color-red-5)" />
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {timeAgo(w.metadata.creationTimestamp)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text ta="center" c="dimmed" py="xl">
                    {items === null ? "Loading…" : "No work items here yet. Launch one with New item."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Card>

      <NewItemModal key={initialWorkflow ?? "item"} initialWorkflow={initialWorkflow} opened={opened} onClose={close} onCreated={(name) => router.push(`/items/${name}`)} />
    </Stack>
  );
}

function NewItemModal({ opened, onClose, onCreated, initialWorkflow }: { opened: boolean; onClose: () => void; onCreated: (name: string) => void; initialWorkflow?: string }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [mirrorTo, setMirrorTo] = useState<string | null>(null);
  const [ticketTargetPick, setTicketTarget] = useState<string | null>(null);
  const { data: options } = useLive<NewItemOptions>(opened ? "/api/new-item-options" : null, () => false);
  // null = untouched: follow the manual source's defaults until the user picks something.
  const [workflowPick, setWorkflow] = useState<string | null>(null);
  const [reposPick, setRepos] = useState<string[] | null>(null);
  const preselected = initialWorkflow && options?.workflows.some((w) => w.name === initialWorkflow) ? initialWorkflow : undefined;
  const workflow = workflowPick ?? preselected ?? options?.defaults.workflow ?? null;
  const repos = reposPick ?? options?.defaults.repositories ?? [];
  const chosenWorkflow = options?.workflows.find((w) => w.name === workflow);
  // ADR-0077: a workflow that publishes a ticket chooses its tracker here instead of mirroring the item.
  const publishes = chosenWorkflow?.publishesTicket;
  const ticketTarget = publishes ? ticketTargetPick ?? publishes.target ?? null : null;
  return (
    <Modal opened={opened} onClose={onClose} title={publishes ? "New ticket" : "New work item"} size="lg">
      {publishes && <Text size="sm" c="dimmed" mb="sm">Agents research the code and the product owner writes the story. You review it; then it is created in the tracker. Nothing is implemented. You can start implementation from the ticket later.</Text>}
      <Stack>
        <TextInput label="Title" placeholder="e.g. Show transcript tokens in the run viewer" value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus required />
        <Textarea
          label="Description"
          description="Describe the intended outcome and constraints. The selected workflow controls planning and human review."
          autosize
          minRows={4}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Textarea
          label="Additional context"
          description="Optional. What agents should know up front (environment, setup, what was already tried), so they don't have to ask."
          autosize
          minRows={2}
          value={context}
          onChange={(e) => setContext(e.currentTarget.value)}
        />
        {/* Descriptions below the inputs keep labels and inputs aligned in one row, however long the text. */}
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="md">
          <Select
            label="Workflow"
            description={chosenWorkflow?.description ?? "How agents and humans work on the item"}
            inputWrapperOrder={["label", "input", "description", "error"]}
            data={(options?.workflows ?? []).map((w) => ({ value: w.name, label: w.name }))}
            value={workflow}
            onChange={(v) => v && setWorkflow(v)}
            allowDeselect={false}
            disabled={!options}
            styles={{ description: { marginTop: 6 } }}
          />
          <MultiSelect
            label="Repositories"
            description="Code the agents research and work on"
            inputWrapperOrder={["label", "input", "description", "error"]}
            data={(options?.repositories ?? []).map((r) => ({ value: r.name, label: r.name }))}
            value={repos}
            onChange={setRepos}
            error={options && repos.length === 0 ? "Pick at least one repository" : undefined}
            disabled={!options}
            styles={{ description: { marginTop: 6 } }}
          />
        </SimpleGrid>
        {publishes && (
          <Select
            label="Publish ticket to"
            description="The tracker the approved story is created in."
            data={(options?.issueTargets ?? []).map((t) => ({ value: t.source, label: `${t.source}${t.project ? ` (${t.project})` : ""}` }))}
            value={ticketTarget}
            onChange={setTicketTarget}
            allowDeselect={false}
            error={options && !ticketTarget ? "Choose a tracker" : undefined}
          />
        )}
        {!publishes && (options?.issueTargets.length ?? 0) > 0 && (
          <Select
            label="Also create in …"
            description="Optional. Proposes an issue for this item in a tracker; it is only created after you approve it on the item page."
            clearable
            data={options!.issueTargets.map((t) => ({ value: t.source, label: `${t.source}${t.project ? ` (${t.project})` : ""}` }))}
            value={mirrorTo}
            onChange={setMirrorTo}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!title.trim() || !options || !workflow || repos.length === 0 || (!!publishes && !ticketTarget)}
            onClick={async () => {
              setBusy(true);
              const wi = await act<WorkItem>(
                "/api/workitems",
                { title, description, context, workflowRef: workflow, repositoryRefs: repos, mirrorTo: publishes ? undefined : mirrorTo ?? undefined,
                  ticketTarget: ticketTarget ?? undefined },
                "Work item created",
              );
              setBusy(false);
              if (wi) {
                setTitle("");
                setDescription("");
                setContext("");
                setWorkflow(null);
                setRepos(null);
                setMirrorTo(null);
                setTicketTarget(null);
                onClose();
                onCreated(wi.metadata.name);
              }
            }}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

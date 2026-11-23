"use client";
import { CurrentStageSummary, StageDrawer, useItemCheckRuns } from "@/ui/stage-drawer.tsx";
import {
  Accordion,
  ActionIcon,
  Affix,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Grid,
  Group,
  List,
  Menu,
  Modal,
  Spoiler,
  Stack,
  Tabs,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconRobot, IconCheck, IconChevronLeft, IconGitPullRequest, IconHandStop, IconX, IconMessageQuestion, IconRefresh, IconHourglass, IconPencil, IconTrash, IconNote, IconSend } from "@tabler/icons-react";
import Link from "next/link";
import { TicketHistory } from "@/ui/ticket-history.tsx";
import { useRouter } from "next/navigation";
import { use, useMemo, useState, type ReactNode } from "react";
import type { AgentRun, Approval, Artifact, Clarification, Conversation, OutboxMessage, IssueProposal } from "@/core/model/kinds.ts";
import { LABEL_SUPERSEDED } from "@/core/model/kinds.ts";
import type { FeedbackView, GateEvidence, WorkItemDetail } from "@/core/ports/app.ts";
import { act, api, useLive } from "@/ui/api.ts";
import { itemPanels, type ItemPanelContext, type ItemPanelRegion } from "@/ui/item-panels.tsx";
import { PhaseBadge, TypeBadge, timeAgo } from "@/ui/badges.tsx";
import { MarkdownView } from "@/ui/markdown.tsx";
import { EvidenceArtifacts } from "@/ui/evidence-artifacts.tsx";
import { ChatPanel, RunDrawer } from "@/ui/run-inspector.tsx";
import { EventTimeline } from "@/ui/event-timeline.tsx";
import { RunList } from "@/ui/run-list.tsx";
import { StartAgentChat } from "@/ui/start-agent-chat.tsx";
import { FollowUpDialog, WorkItemFollowUps } from "@/ui/work-item-followups.tsx";
import { IssueProposalsPanel } from "@/ui/issue-proposals.tsx";
import { ticketDraftMarkdown } from "@/ui/artifact-content.ts";
import { RecoveryPanel } from "@/ui/recovery-panel.tsx";
import type { PlanningWorkspace as PlanningWorkspaceData } from "@/core/ports/planning.ts";
import { normalizeQuestions } from "@/core/questions.ts";
import { AnnotatedArtifact, NoteCount, travellingNotes } from "@/ui/selection-feedback.tsx";


const ALERT_STYLES = { title: { color: "var(--mantine-color-text)" } };
const PHASE_COLOR: Record<string, string> = { inception: "indigo", construction: "cyan", operations: "teal", build: "cyan" };

export default function ItemPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const { data: d, error } = useLive<WorkItemDetail>(`/api/workitems/${name}`, (n) => n.workItem === name || n.name === name);
  const planning = useLive<PlanningWorkspaceData>(d?.capabilities.includes("planning") ? `/api/workitems/${encodeURIComponent(name)}/planning` : null, (n) =>
    n.workItem === name || n.name === name || ["Workflow", "Repository"].includes(n.kind ?? ""));
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>(null);
  const checkRuns = useItemCheckRuns(name);
  const [askOpen, setAskOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [useIssue, setUseIssue] = useState<IssueProposal | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { data: chats, error: chatsError } = useLive<Conversation[]>(chatOpen ? `/api/chats?workItem=${encodeURIComponent(name)}` : null, (n) => n.kind === "Conversation");

  async function deleteItem() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/workitems/${encodeURIComponent(name)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Delete failed (HTTP ${response.status})`);
      router.replace("/");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  if (error) return <Alert color="red" title="Error">{error}</Alert>;
  if (!d) return <Text c="dimmed">Loading…</Text>;
  const wi = d.workItem;
  const st = wi.status;
  const planningEnabled = planning.data?.enabled === true;
  const openDecisions = planning.data?.approval && planning.data.readiness === "needs-answers" ? planning.data.unansweredQuestions.length : 0;
  const planWaitsForAnswers = openDecisions
    ? `Your answers to ${openDecisions} required planning decision${openDecisions === 1 ? "" : "s"}. Approval opens once the plan is updated with them.`
    : undefined;
  // Once inception is over, the plan is reference material and construction progress becomes the main view.
  const constructing = !!st?.lifecyclePhase && st.lifecyclePhase !== "inception";
  const openClar = d.clarifications.find((c) => c.metadata.name === st?.blockedBy?.name && st?.phase === "Blocked");
  const openAppr = d.approvals.find((a) => a.metadata.name === st?.blockedBy?.name && st?.phase === "AwaitingApproval");
  const run = d.runs.find((r) => r.metadata.name === openRun) ?? null;
  const panelContext: ItemPanelContext = { detail: d, constructing, planning, onOpenRun: setOpenRun };
  const panels = (region: ItemPanelRegion) => itemPanels(region, panelContext).map((p) => p.render(panelContext));
  const operational = itemPanels("operational", panelContext);
  // Re-publication (ADR-0054) delivers the same PR again in later rounds: show each PR once.
  const pullRequests = [...new Map(d.outbox.flatMap((m) => {
    const result = m.status?.result;
    if (m.spec.action !== "open-pull-request" || typeof result?.url !== "string") return [];
    const workspace = d.workspaces.find((w) => w.metadata.name === m.spec.payload.workspace);
    return [[result.url, { url: result.url, number: String(result.number), repository: workspace?.spec.repositoryRef.name ?? "repository" }] as const];
  })).values()];

  return (
    <Stack gap="lg" maw={1400} mx="auto">
      <Anchor component={Link} href="/" size="sm">
        <Group gap={4}>
          <IconChevronLeft size={14} /> Dashboard
        </Group>
      </Anchor>

      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Title order={2}>{wi.spec.title}</Title>
            <PhaseBadge phase={st?.phase} size="md" />
            {openDecisions > 0 && <Badge color="yellow" variant="outline" size="md">needs your answers</Badge>}
            <TypeBadge type={st?.classification?.type} />
            {st?.classification?.priority && <Badge variant="outline">{st.classification.priority}</Badge>}
            {pullRequests.map((pr) => (
              <Tooltip key={pr.url} label={`Open ${pr.repository} PR #${pr.number} on GitHub`}>
                <Anchor href={pr.url} target="_blank" rel="noopener noreferrer" fw={600}>
                  <Group gap={4} wrap="nowrap"><IconGitPullRequest size={18} />#{pr.number}</Group>
                </Anchor>
              </Tooltip>
            ))}
          </Group>
          <Text size="sm" c="dimmed" ff="monospace">
            {wi.metadata.name} · source {wi.spec.sourceRef.name}
            {wi.spec.externalRef?.url && (
              <>
                {" · "}
                <Anchor href={wi.spec.externalRef.url} target="_blank" size="sm">
                  #{wi.spec.externalRef.id}
                </Anchor>
              </>
            )}
            {" · "}workflow {wi.spec.workflowRef?.name} · repos {(wi.spec.repositoryRefs ?? []).map((r) => r.name).join(", ") || "–"}
          </Text>
        </div>
        <Group gap="sm">
          <RestartMenu d={d} />
          <Menu position="bottom-end">
            <Menu.Target><Button variant="default">More</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconRobot size={14} />} onClick={() => setChatOpen(true)}>Chat with agent</Menu.Item>
              <Menu.Item onClick={() => setFollowUpOpen(true)}>Create follow-up</Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => { setDeleteError(null); setDeleteOpen(true); }}>
                Delete work item
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <StageProgress d={d} onOpen={setOpenStage} />
      <CurrentStageSummary d={d} checks={checkRuns} onOpen={setOpenStage} waitingFor={planWaitsForAnswers} />
      <StageDrawer d={d} checks={checkRuns} stage={openStage} onClose={() => setOpenStage(null)} onOpenRun={(r) => { setOpenStage(null); setOpenRun(r); }} />
      {followUpOpen && <FollowUpDialog key={useIssue?.metadata.name ?? "new"} item={wi} prefill={useIssue ? { title: useIssue.spec.title, body: useIssue.spec.body, targetSource: useIssue.spec.targetRef?.name } : undefined} onClose={() => { setFollowUpOpen(false); setUseIssue(null); }} />}
      <Modal opened={deleteOpen} onClose={() => { if (!deleting) setDeleteOpen(false); }} title="Delete work item?" centered>
        <Stack>
          <Text size="sm">
            This permanently deletes <strong>{wi.spec.title}</strong> and its owned resources. This action cannot be undone.
          </Text>
          {deleteError && <Alert color="red" title="Could not delete work item">{deleteError}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" disabled={deleting} onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button color="red" loading={deleting} onClick={() => void deleteItem()}>Delete work item</Button>
          </Group>
        </Stack>
      </Modal>
      <WorkItemFollowUps item={wi} />
      {panels("summary")}
      <Modal opened={chatOpen} onClose={() => setChatOpen(false)} title="Chat with an agent about this work item" size="lg">
        <Stack>
          <Text size="sm">The agent receives this item's details, runs, artifacts and human input, refreshed before each turn, and can use its allowed read-only MCP tools. The workflow and gates stay unchanged. Repository file access is not enabled by attaching the item.</Text>
          <Text size="sm" fw={600}>Context: {wi.spec.title}</Text>
          <StartAgentChat workItemName={name} />
          {chatsError && <Alert color="red">{chatsError}</Alert>}
          {!!chats?.length && <Stack gap="xs">
            <Text size="sm" fw={600}>Resume a conversation</Text>
            {chats.map((c) => <Anchor key={c.metadata.name} component={Link} href={`/chats/${c.metadata.name}`}>{c.spec.title || c.metadata.name} ({c.spec.agentRef?.name})</Anchor>)}
          </Stack>}
        </Stack>
      </Modal>
      {wi.spec.conversationRef && <Anchor component={Link} href={`/chats/${wi.spec.conversationRef.name}`} size="sm">Originating agent conversation</Anchor>}

      {st?.phase === "Waiting" && (
        <Alert color="violet" icon={<IconHourglass />} title="Waiting">
          {st.message} The item continues by itself once this is resolved.
        </Alert>
      )}
      {st?.phase === "Failed" && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Failed">
          {st.message}
        </Alert>
      )}
      <RecoveryPanel key={`recovery-${wi.metadata.uid ?? wi.metadata.name}`} detail={d} />
      <FeedbackSubmitBar d={d} withPlan={!!planning.data?.canRevise && !constructing ? travellingNotes(d, planning.data.revisionStage) : 0} />
      {/* What needs a human now comes first. Keyed by clarification: a new round's questions start with fresh answer state. */}
      {openClar && <ClarificationPanel key={openClar.metadata.name} c={openClar} d={d} />}
      {openAppr && !openAppr.spec.ticketPublication && (openAppr.spec.verification?.kind !== "plan" || !!openAppr.spec.verification.rebinds || !d.capabilities.includes("planning")) && <ApprovalPanel key={openAppr.metadata.name} a={openAppr} d={d} onOpenRun={setOpenRun} />}
      {panels("attention")}
      {panels("primary")}

      <OperationalDetails collapsed={planningEnabled}>
      {operational.length > 0 && <Stack mb="md">{operational.map((p) => p.render(panelContext))}</Stack>}
      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          {!planningEnabled && <ContextCard d={d} />}
          <Card className="sf-surface">
            <Tabs defaultValue="artifacts">
              <Tabs.List>
                <Tabs.Tab value="artifacts">Artifacts ({d.artifacts.length})</Tabs.Tab>
                <Tabs.Tab value="runs">Agent runs ({d.runs.length})</Tabs.Tab>
                <Tabs.Tab value="description">Description</Tabs.Tab>
                {wi.spec.sourceHistory && <Tabs.Tab value="ticket-history">Ticket history ({wi.spec.sourceHistory.comments.length})</Tabs.Tab>}
                <Tabs.Tab value="human">Human input ({d.clarifications.length + d.approvals.length})</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="artifacts" pt="md">
                <Artifacts d={d} />
              </Tabs.Panel>
              <Tabs.Panel value="runs" pt="md">
                <RunList d={d} onOpen={setOpenRun} />
              </Tabs.Panel>
              <Tabs.Panel value="description" pt="md">
                <MarkdownView>{wi.spec.description || "_No description._"}</MarkdownView>
              </Tabs.Panel>
              {wi.spec.sourceHistory && (
                <Tabs.Panel value="ticket-history" pt="md">
                  <TicketHistory history={wi.spec.sourceHistory} externalId={wi.spec.externalRef?.id} url={wi.spec.externalRef?.url} />
                </Tabs.Panel>
              )}
              <Tabs.Panel value="human" pt="md">
                <HumanHistory clarifications={d.clarifications} approvals={d.approvals} />
              </Tabs.Panel>
            </Tabs>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }} style={{ position: "sticky", top: 68, alignSelf: "flex-start" }}>
          <FeedbackPanel d={d} onOpenRun={setOpenRun} />
          <IssueProposalsPanel issues={d.issues} onUse={(i) => { setUseIssue(i); setFollowUpOpen(true); }} />
          {d.knowledge.length > 0 && (
            <Card className="sf-surface" mb="md">
              <Title order={5} mb={4}>
                Knowledge
              </Title>
              <Text size="xs" c="dimmed" mb="sm">
                Proposed by this item&apos;s agents. Used by others only after approval.
              </Text>
              <Stack gap={6}>
                {d.knowledge.map((k) => (
                  <Group key={k.metadata.name} gap="xs" wrap="nowrap" justify="space-between">
                    <Anchor component={Link} href={`/knowledge/${k.metadata.name}`} size="sm" lineClamp={1}>
                      {k.spec.title}
                    </Anchor>
                    <PhaseBadge phase={k.status?.phase ?? "Proposed"} size="xs" />
                  </Group>
                ))}
              </Stack>
            </Card>
          )}
          {d.workspaces.length > 0 && (
            <Card className="sf-surface" mb="md">
              <Title order={5} mb="sm">
                Workspace
              </Title>
              <Stack gap="sm">
                {d.workspaces.map((w) => (
                  <Stack key={w.metadata.name} gap={2}>
                    <Group gap={6}>
                      <Anchor component={Link} href={`/resources/workspaces/${w.metadata.name}`} size="sm" fw={500}>
                        {w.spec.repositoryRef.name}
                      </Anchor>
                      <PhaseBadge phase={w.status?.phase ?? "Pending"} size="xs" />
                    </Group>
                    <Text size="xs" ff="monospace">
                      {w.spec.branch}
                      {w.status?.baseCommit && ` · base ${w.status.baseCommit.slice(0, 10)}`}
                    </Text>
                    {w.status?.path && (
                      <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                        {w.status.path}
                      </Text>
                    )}
                    {pullRequestMessages(d.outbox, w.metadata.name)
                      .map((m) => (
                        <Group key={m.metadata.name} gap={6}>
                          <IconGitPullRequest size={14} />
                          {typeof m.status?.result?.url === "string" ? (
                            <Anchor href={m.status.result.url} target="_blank" size="sm" fw={500}>
                              Draft PR #{String(m.status.result.number)}
                            </Anchor>
                          ) : (
                            <Text size="xs" c={m.status?.phase === "Failed" ? "red" : "dimmed"}>
                              PR {m.status?.phase === "Failed" ? `failed: ${m.status.lastError ?? ""}` : `pending${m.status?.attempts ? ` (attempt ${m.status.attempts}${m.status.lastError ? `: ${m.status.lastError}` : ""})` : "…"}`}
                            </Text>
                          )}
                        </Group>
                      ))}
                    {w.status?.message && (
                      <Text size="xs" c="red">
                        {w.status.message}
                      </Text>
                    )}
                    {w.status?.setupLog && (
                      <Accordion variant="contained" chevronPosition="left">
                        <Accordion.Item value="log">
                          <Accordion.Control>
                            <Text size="xs">Setup log</Text>
                          </Accordion.Control>
                          <Accordion.Panel>
                            <div className="sf-transcript-msg">{w.status.setupLog}</div>
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    )}
                  </Stack>
                ))}
              </Stack>
            </Card>
          )}
          <EventTimeline events={d.events} />
        </Grid.Col>
      </Grid>
      </OperationalDetails>

      {!askOpen && (
        <Affix position={{ bottom: 24, right: 24 }}>
          <Button size="md" radius="xl" leftSection={<IconMessageQuestion size={18} />} onClick={() => setAskOpen(true)}
            style={{ boxShadow: "var(--mantine-shadow-lg)" }}>
            Ask about this item
          </Button>
        </Affix>
      )}

      <Drawer opened={askOpen} onClose={() => setAskOpen(false)} position="right" size="xl" title={<Text fw={600}>Ask about this work item</Text>}>
        <ChatPanel
          existing={d.conversations.filter((c) => c.spec.purpose === "explain-item")}
          start={() => act<Conversation>(`/api/workitems/${name}/conversations`, {})}
          placeholder="e.g. What did the product owner decide, and why?"
          intro="Answers come from this item's record: every agent run, artifact, human input and key event. Read-only."
          suggestions={["Summarise what happened so far", "What did the product owner do?", "Which open questions or risks remain?", "Why did the item go back to an earlier stage?"]}
        />
      </Drawer>

      <RunDrawer
        run={run}
        original={run?.spec.replayOf ? (d.runs.find((r) => r.metadata.name === run.spec.replayOf!.name) ?? null) : null}
        artifacts={d.artifacts}
        conversations={d.conversations}
        onClose={() => setOpenRun(null)}
        onOpen={setOpenRun}
      />
    </Stack>
  );
}

function OperationalDetails({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  if (!collapsed) return children;
  return <Accordion variant="contained">
    <Accordion.Item value="details">
      <Accordion.Control>Details: verification, checks, artifacts, agent runs, history</Accordion.Control>
      <Accordion.Panel>{children}</Accordion.Panel>
    </Accordion.Item>
  </Accordion>;
}

/** ADR-0032: human-provided context every agent sees. Editing doesn't re-run finished steps (Restart does). */
function ContextCard({ d }: { d: WorkItemDetail }) {
  const wi = d.workItem;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(wi.spec.context ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const hasRuns = d.runs.length > 0;
  const available = 20000 - (wi.spec.originSnapshot?.content.length ?? 0);
  return (
    <Card className="sf-surface" mb="md">
      <Group justify="space-between" mb={editing || wi.spec.context ? "xs" : 0}>
        <div>
          <Title order={5}>Additional context</Title>
          <Text size="xs" c="dimmed">
            What agents should know up front: environment, customer setup, what was already tried. Every agent sees it.
          </Text>
        </div>
        {!editing && (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPencil size={14} />}
            onClick={() => {
              setText(wi.spec.context ?? "");
              setSaved(false);
              setEditing(true);
            }}
          >
            {wi.spec.context ? "Edit" : "Add context"}
          </Button>
        )}
      </Group>
      {editing ? (
        <Stack gap="xs">
          <Textarea
            autosize
            minRows={4}
            maxRows={16}
            placeholder={"e.g. Environment: prod (eu-central). The team uses the Rover CLI, not the UI.\nAlready tried: re-applying the subscription."}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            error={text.length > available ? `At most ${available} characters fit alongside inherited evidence.` : undefined}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await act(`/api/workitems/${wi.metadata.name}/context`, { context: text }, "Context saved");
                setBusy(false);
                if (r) {
                  setEditing(false);
                  setSaved(true);
                }
              }}
            >
              Save
            </Button>
          </Group>
        </Stack>
      ) : (
        wi.spec.context && <MarkdownView>{wi.spec.context}</MarkdownView>
      )}
      {saved && hasRuns && (
        <Text size="xs" c="dimmed" mt="xs">
          Agents use it from their next run. To redo steps that already ran, use Restart.
        </Text>
      )}
    </Card>
  );
}

/** Re-runs the workflow in a new round; earlier output stays visible as superseded history. */
function RestartMenu({ d }: { d: WorkItemDetail }) {
  // undefined: closed; null: from the beginning; string: from that stage.
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button variant="default" leftSection={<IconRefresh size={16} />}>
            Restart
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Re-run agents in a new round</Menu.Label>
          <Menu.Item onClick={() => setTarget(null)}>From the beginning</Menu.Item>
          <Menu.Divider />
          {d.stages.map((s) => (
            <Menu.Item key={s.name} onClick={() => setTarget(s.name)}>
              From {s.name}{" "}
              <Text span size="xs" c="dimmed">
                ({s.lifecyclePhase})
              </Text>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      {target !== undefined && <RestartDialog d={d} stage={target ?? undefined} onClose={() => setTarget(undefined)} />}
    </>
  );
}

/** ADR-0078: restart with the context and notes the re-run should see, in one step. */
function RestartDialog({ d, stage, onClose }: { d: WorkItemDetail; stage?: string; onClose: () => void }) {
  const wi = d.workItem;
  const [context, setContext] = useState(wi.spec.context ?? "");
  const [busy, setBusy] = useState(false);
  const from = stage ? d.stages.findIndex((s) => s.name === stage) : 0;
  const rerun = new Set(d.stages.slice(Math.max(0, from)).map((s) => s.name));
  const drafts = d.feedback.filter((f) => !f.feedback.spec.submitted && rerun.has(f.feedback.spec.producedBy.stage));
  const [includeNotes, setIncludeNotes] = useState(drafts.length > 0);
  const limit = 20000 - (wi.spec.originSnapshot?.content.length ?? 0);
  const restart = async () => {
    setBusy(true);
    const ok = await act(`/api/workitems/${wi.metadata.name}/restart`,
      { stage, ...(context !== (wi.spec.context ?? "") ? { context } : {}), includeDraftNotes: includeNotes },
      stage ? `Restarting from ${stage}` : "Restarting from the beginning");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal opened onClose={onClose} title={stage ? `Restart from ${stage}` : "Restart from the beginning"} size="lg" closeOnClickOutside={!busy}>
      <Stack>
        <Text size="sm">
          Agents re-run {stage ? <><b>{stage}</b> and every later stage</> : "every stage"} in a new round. Earlier output of those stages is kept as
          superseded history. Approvals of re-run stages are asked again.
        </Text>
        <Textarea
          label="Additional context"
          description="What every agent should know for this round, e.g. new decisions or requirements. Replaces the item's current additional context."
          placeholder="CRD schemas must be strictly typed. Secrets only by reference, in one configured namespace..."
          value={context}
          onChange={(e) => setContext(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={14}
          disabled={busy}
          error={context.length > limit ? `At most ${limit} characters alongside inherited evidence.` : undefined}
          data-autofocus
        />
        {drafts.length > 0 && (
          <Checkbox
            label={`Send my ${drafts.length} draft inline note${drafts.length === 1 ? "" : "s"} on the re-run stages (${[...new Set(drafts.map((f) => f.feedback.spec.producedBy.stage))].join(", ")})`}
            description="Each note reaches the agent that produced the annotated passage, once."
            checked={includeNotes}
            onChange={(e) => setIncludeNotes(e.currentTarget.checked)}
            disabled={busy}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button leftSection={<IconRefresh size={16} />} loading={busy} disabled={context.length > limit} onClick={restart}>Restart</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function StageProgress({ d, onOpen }: { d: WorkItemDetail; onOpen: (stage: string) => void }) {
  const st = d.workItem.status;
  const idx = d.stages.findIndex((s) => s.name === st?.stage);
  const done = st?.phase === "Done";
  return (
    <Card className="sf-surface" p="sm">
      <Group gap={6} wrap="wrap">
        {d.stages.map((s, i) => {
          const current = i === idx && !done;
          const passed = done || i < idx;
          const verdict = d.evidence.items.find((i) => i.stage === s.name && i.severity !== "ok");
          const color = verdict?.severity === "blocking" ? "red" : verdict?.severity === "warning" ? "yellow" : (PHASE_COLOR[s.lifecyclePhase] ?? "gray");
          return (
            <Tooltip key={s.name} label={`${s.lifecyclePhase}${s.gate ? ` · gate: ${s.gate}` : ""}${verdict ? ` · ${verdict.label}` : ""} · click for details`}>
              <Badge
                component="button"
                onClick={() => onOpen(s.name)}
                size="lg"
                color={current && st?.phase === "Blocked" ? "orange" : current && st?.phase === "AwaitingApproval" ? "yellow" : color}
                variant={current ? "filled" : passed ? "light" : "outline"}
                leftSection={
                  verdict?.severity === "blocking" ? <IconX size={12} /> : passed ? <IconCheck size={12} /> : s.gate === "human-approval" ? <IconHandStop size={12} /> : undefined
                }
                style={{ opacity: passed || current ? 1 : 0.55, cursor: "pointer" }}
              >
                {s.name}
              </Badge>
            </Tooltip>
          );
        })}
      </Group>
    </Card>
  );
}

function ClarificationPanel({ c, d }: { c: Clarification; d: WorkItemDetail }) {
  const [answers, setAnswers] = useState<string[]>(c.spec.questions.map(() => ""));
  const [skipped, setSkipped] = useState<boolean[]>(c.spec.questions.map(() => false));
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  // Older clarifications have no askedBy: only a run whose questions are exactly these asked them; anything else is a factory stop.
  const asker = c.spec.askedBy?.agentRunRef
    ? d.runs.find((r) => r.metadata.name === c.spec.askedBy!.agentRunRef!.name)
    : c.spec.askedBy?.gate ? undefined
    : [...d.runs].reverse().find((r) => r.spec.stage === c.spec.stage && (() => { const t = normalizeQuestions(r.status?.result?.questions); const b = t.filter((x) => x.blocker).map((x) => x.text); return (b.length ? b : t.map((x) => x.text)).join("\n") === c.spec.questions.join("\n"); })());
  const gate = !asker ? c.spec.askedBy?.gate : undefined;
  const done = c.spec.questions.filter((_, i) => skipped[i] || answers[i]?.trim()).length;
  const anyAnswer = answers.some((a, i) => !skipped[i] && a?.trim());
  // Sendable once every question is handled (answered or explicitly "Don't know"), or at least one is answered.
  const canSend = anyAnswer || done === c.spec.questions.length;
  const set = <T,>(arr: T[], i: number, v: T) => arr.map((x, j) => (j === i ? v : x));

  return (
    <Card withBorder radius="md" p="md" style={{ borderColor: "var(--mantine-color-orange-5)", borderLeftWidth: 4 }}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon color="orange" variant="light" radius="xl">
              <IconHandStop size={16} />
            </ThemeIcon>
            <div>
              <Text fw={600}>
                {asker ? `${asker.spec.agentRef.name} asks` : "The factory needs your decision"}
                <Text span c="dimmed" fw={400}>
                  {" "}
                  · {c.spec.questions.length} question{c.spec.questions.length === 1 ? "" : "s"} in {c.spec.stage}
                  {gate ? ` (${gate} gate)` : ""}
                </Text>
              </Text>
            </div>
          </Group>
          <Badge variant="light" color={done === c.spec.questions.length ? "teal" : "orange"} style={{ flexShrink: 0 }}>
            {done}/{c.spec.questions.length} answered
          </Badge>
        </Group>

        {(asker?.status?.result?.summary || c.spec.details) && (
          <Card withBorder p="sm" radius="sm" className="sf-surface">
            <Text size="xs" c="dimmed" mb={4}>
              {asker ? `Context: what ${asker.spec.agentRef.name} did before asking` : "Context"}
            </Text>
            <Spoiler maxHeight={96} showLabel="Show all" hideLabel="Show less">
              <MarkdownView>{c.spec.details ?? asker!.status!.result!.summary!}</MarkdownView>
            </Spoiler>
          </Card>
        )}

        <Stack gap="xs">
          {c.spec.questions.map((q, i) => (
            <Card key={i} withBorder p="sm" radius="sm" className="sf-surface" style={{ opacity: skipped[i] ? 0.6 : 1 }}>
              <Group gap="xs" align="flex-start" wrap="nowrap" mb={6}>
                <Badge size="sm" variant="filled" color={skipped[i] ? "gray" : answers[i].trim() ? "teal" : "orange"} circle>
                  {i + 1}
                </Badge>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Spoiler maxHeight={200} showLabel="Show all" hideLabel="Show less">
                    <MarkdownView>{q}</MarkdownView>
                  </Spoiler>
                </div>
              </Group>
              {skipped[i] ? (
                <Group justify="space-between">
                  <Text size="xs" c="dimmed">
                    Skipped: the agent will be told you don&apos;t know.
                  </Text>
                  <Button size="compact-xs" variant="subtle" onClick={() => setSkipped(set(skipped, i, false))}>
                    Answer instead
                  </Button>
                </Group>
              ) : (
                <Group gap="xs" align="flex-start" wrap="nowrap">
                  {(c.spec.options?.[i] ?? []).length > 0 && (
                    <Group gap={4} style={{ flexShrink: 0 }}>
                      {(c.spec.options?.[i] ?? []).map((o) => (
                        <Button key={o} size="compact-xs" variant={answers[i] === o ? "filled" : "light"} onClick={() => setAnswers((a) => set(a, i, o))}>
                          {o}
                        </Button>
                      ))}
                    </Group>
                  )}
                  <Textarea
                    style={{ flex: 1 }}
                    size="sm"
                    autosize
                    minRows={1}
                    maxRows={6}
                    placeholder="Your answer"
                    value={answers[i] ?? ""}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setAnswers((a) => set(a, i, v));
                    }}
                  />
                  <Button size="compact-sm" variant="subtle" color="gray" mt={4} onClick={() => setSkipped(set(skipped, i, true))}>
                    Don&apos;t know
                  </Button>
                </Group>
              )}
            </Card>
          ))}
        </Stack>

        <Group justify={asker ? "space-between" : "flex-end"}>
          {asker && (
            <Button variant="subtle" size="xs" leftSection={<IconMessageQuestion size={14} />} onClick={() => setAskOpen(true)}>
              Ask {asker.spec.agentRef.name} about these questions
            </Button>
          )}
          <Button
            color="orange"
            loading={busy}
            disabled={!canSend}
            onClick={async () => {
              setBusy(true);
              await act(`/api/clarifications/${c.metadata.name}/answer`, { answers: answers.map((a, i) => (skipped[i] ? "" : a)) }, "Answers sent. Resuming.");
              setBusy(false);
            }}
          >
            Send answers &amp; resume
          </Button>
        </Group>
      </Stack>

      {asker && (
        <Drawer opened={askOpen} onClose={() => setAskOpen(false)} position="right" size="lg" title={<Text fw={600}>Ask {asker.spec.agentRef.name} about its questions</Text>}>
          <Stack gap="sm">
            <Card withBorder p="xs" className="sf-surface">
              <Text size="xs" c="dimmed" mb={4}>
                Questions
              </Text>
              {c.spec.questions.map((q, i) => (
                <Text key={i} size="sm">
                  {i + 1}. {q}
                </Text>
              ))}
            </Card>
            <ChatPanel
              existing={d.conversations.filter((cv) => cv.spec.agentRunRef?.name === asker.metadata.name)}
              start={() => act<Conversation>("/api/conversations", { runName: asker.metadata.name })}
              placeholder="e.g. What do you mean by question 2? Which options do I have?"
              intro="The agent explains its questions from its recorded run (read-only). Your answers stay in the panel."
              suggestions={["Why do you need this information?", "What would you assume if I don't know?", "Can you give me options for each question?"]}
            />
          </Stack>
        </Drawer>
      )}
    </Card>
  );
}

const DELEGATE_INSTRUCTION =
  "Delegated by the human: for all open decisions and questions raised at this gate, use the reviewer's recommended option " +
  "(or the most conservative reasonable default), document each choice under a 'Decisions taken' heading, and do not ask again.";

const SEVERITY = {
  blocking: { color: "red", icon: IconX, label: "Blocking" },
  warning: { color: "yellow", icon: IconAlertTriangle, label: "Warning" },
  ok: { color: "teal", icon: IconCheck, label: "OK" },
} as const;

function EvidenceList({ evidence, artifacts, onOpenRun }: { evidence: GateEvidence; artifacts: WorkItemDetail["artifacts"]; onOpenRun: (n: string) => void }) {
  if (!evidence.items.length) {
    return (
      <Text size="sm" c="dimmed">
        No structured verdicts or checks recorded yet.
      </Text>
    );
  }
  return (
    <Stack gap={6}>
      {evidence.items.map((i, idx) => {
        const S = SEVERITY[i.severity];
        return (
          <Group key={idx} gap={8} wrap="nowrap" align="flex-start">
            <ThemeIcon size="sm" radius="xl" color={S.color} variant={i.severity === "ok" ? "light" : "filled"}>
              <S.icon size={12} />
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={i.severity === "ok" ? 400 : 600}>
                {i.label}
                {i.runName && (
                  <Anchor size="xs" ml={6} onClick={() => onOpenRun(i.runName!)}>
                    open run
                  </Anchor>
                )}
              </Text>
              {i.detail && (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {i.detail}
                </Text>
              )}
              <EvidenceArtifacts refs={i.artifacts} artifacts={artifacts} />
            </div>
          </Group>
        );
      })}
    </Stack>
  );
}

/** The latest current output of each artifact type produced in the gated stage (e.g. the design under review). */
function stageOutputs(d: WorkItemDetail, stage: string) {
  const runs = new Set(d.runs.filter((r) => r.spec.stage === stage && !r.spec.replayOf && !r.metadata.labels?.[LABEL_SUPERSEDED]
    && r.status?.phase === "Succeeded").map((r) => r.metadata.name));
  const latest = new Map<string, WorkItemDetail["artifacts"][number]>();
  for (const artifact of d.artifacts) {
    if (artifact.metadata.labels?.[LABEL_SUPERSEDED] || !runs.has(artifact.spec.producedBy?.agentRunRef.name ?? "")) continue;
    latest.set(artifact.spec.artifactTypeRef.name, artifact);
  }
  return [...latest.values()];
}

function ApprovalPanel({ a, d, onOpenRun }: { a: Approval; d: WorkItemDetail; onOpenRun: (n: string) => void }) {
  const evidence = d.evidence;
  const outputs = useMemo(() => stageOutputs(d, a.spec.stage), [d, a.spec.stage]);
  const feedbackPlan = d.feedbackPlan;
  const [comment, setComment] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const blocking = evidence.status === "blocking";
  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    await act(`/api/approvals/${a.metadata.name}/decide`, { decision, comment, override: decision === "approve" && blocking ? override : undefined }, decision === "approve" ? "Approved" : "Rejected");
    setBusy(null);
  };
  const color = blocking ? "red" : evidence.status === "warning" ? "yellow" : "teal";
  return (
    <Alert color={color} variant="outline" styles={ALERT_STYLES} title={`Gate: ${a.spec.stage} needs human approval`} icon={blocking ? <IconAlertTriangle /> : <IconHandStop />}>
      <Stack gap="sm" mt="xs">
        {blocking && (
          <Alert color="red" variant="filled" icon={<IconX />} title="Failing evidence: do not release by accident">
            The verification or checks failed. Approving requires an explicit override with a reason, which is recorded.
          </Alert>
        )}
        <Card withBorder p="sm" className="sf-surface">
          <Group justify="space-between" mb={6}>
            <Text size="sm" fw={600}>
              Evidence
            </Text>
            <Badge color={color} variant={blocking ? "filled" : "light"}>
              {SEVERITY[evidence.status].label}
            </Badge>
          </Group>
          <EvidenceList evidence={evidence} artifacts={d.artifacts} onOpenRun={onOpenRun} />
        </Card>
        {outputs.length > 0 && (
          <Accordion variant="contained" defaultValue={outputs[0].metadata.name}>
            {outputs.map((artifact) => (
              <Accordion.Item key={artifact.metadata.name} value={artifact.metadata.name}>
                <Accordion.Control>Under review: {artifact.spec.artifactTypeRef.name} by {artifact.spec.producedBy?.agentRef.name}</Accordion.Control>
                <Accordion.Panel>
                  <ArtifactBody d={d} a={artifact} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
        {feedbackPlan && (
          <Alert color="yellow" p="xs" icon={<IconNote size={16} />} styles={ALERT_STYLES}>
            <Text size="sm">
              You have {feedbackPlan.drafts} unsubmitted feedback note{feedbackPlan.drafts === 1 ? "" : "s"}.{" "}
              {feedbackPlan.action === "reject"
                ? "Submit them from the feedback bar above to request changes: that rejects this gate with your notes."
                : `Submitting them from the feedback bar above restarts from ${feedbackPlan.stage}. Approving or rejecting here leaves them as drafts.`}
            </Text>
          </Alert>
        )}
        {a.spec.approvers.length > 0 && (
          <Text size="sm">
            Approvers: {a.spec.approvers.map((x) => x.role).join(", ")} <Text span size="xs" c="dimmed">(role checks arrive in v0.4)</Text>
          </Text>
        )}
        {a.spec.criteria?.length ? (
          <List size="sm">
            {a.spec.criteria.map((c) => (
              <List.Item key={c}>{c}</List.Item>
            ))}
          </List>
        ) : null}
        <Textarea
          placeholder={blocking ? "Reason for approving despite failures (required, min. 10 characters)" : "Comment (optional)"}
          autosize
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          error={blocking && override && comment.trim().length < 10 ? "A reason of at least 10 characters is required" : undefined}
        />
        {blocking && (
          <Checkbox
            color="red"
            label="I understand the evidence is failing and want to approve anyway"
            checked={override}
            onChange={(e) => setOverride(e.currentTarget.checked)}
          />
        )}
        <Group justify="space-between">
          {!blocking ? (
            <Tooltip
              multiline
              w={360}
              label="Approve and delegate every open decision: agents use the reviewer's recommended option (or a conservative default), document each choice, and don't ask again. Your comment is added."
            >
              <Button
                variant="light"
                color="teal"
                leftSection={<IconRobot size={14} />}
                loading={busy === "delegate"}
                onClick={async () => {
                  setBusy("delegate");
                  const text = [DELEGATE_INSTRUCTION, comment.trim()].filter(Boolean).join("\n\nAdditional notes: ");
                  await act(`/api/approvals/${a.metadata.name}/decide`, { decision: "approve", comment: text }, "Approved; agents decide open points");
                  setBusy(null);
                }}
              >
                Approve &amp; let agents decide
              </Button>
            </Tooltip>
          ) : (
            <span />
          )}
          <Group>
          <Button variant={blocking ? "filled" : "default"} color="red" leftSection={<IconX size={14} />} loading={busy === "reject"} onClick={() => decide("reject")}>
            Reject
          </Button>
          <Button
            color={blocking ? "red" : "teal"}
            variant={blocking ? "outline" : "filled"}
            leftSection={<IconCheck size={14} />}
            loading={busy === "approve"}
            disabled={blocking && (!override || comment.trim().length < 10)}
            onClick={() => decide("approve")}
          >
            {blocking ? "Approve despite failures" : "Approve"}
          </Button>
          </Group>
        </Group>
        {blocking && (!override || comment.trim().length < 10) && (
          <Text size="xs" c="dimmed" ta="right">
            To approve despite failing evidence, tick the checkbox and give a reason of at least 10 characters.
          </Text>
        )}
      </Stack>
    </Alert>
  );
}

function Artifacts({ d }: { d: WorkItemDetail }) {
  const sorted = useMemo(() => [...d.artifacts].reverse(), [d.artifacts]);
  if (!sorted.length) return <Text c="dimmed" size="sm">No artifacts yet.</Text>;
  const superseded = (a: Artifact) =>
    !!(a.metadata.labels?.[LABEL_SUPERSEDED] || d.runs.find((r) => r.metadata.name === a.spec.producedBy?.agentRunRef.name)?.metadata.labels?.[LABEL_SUPERSEDED]);
  return (
    <Stack gap="xs">
    <Text size="xs" c="dimmed">
      Select text in an artifact to ask its agent about it or to leave a feedback note.
    </Text>
    {/* Re-key on count so the newest artifact opens when new ones arrive. */}
    <Accordion key={sorted.length} variant="separated" defaultValue={sorted[0]?.metadata.name}>
      {sorted.map((a) => (
        <Accordion.Item key={a.metadata.name} value={a.metadata.name}>
          <Accordion.Control>
            <Group gap="xs">
              <Badge variant="light">{a.spec.artifactTypeRef.name}</Badge>
              {(() => {
                const outcome = d.runs.find((r) => r.metadata.name === a.spec.producedBy?.agentRunRef.name)?.status?.result?.outcome;
                if (!outcome) return null;
                const sev = ({ fail: "red", partial: "yellow", pass: "teal", "changes-requested": "yellow", approve: "teal" } as Record<string, string>)[outcome] ?? "gray";
                return (
                  <Badge color={sev} variant={sev === "red" ? "filled" : "light"} size="sm">
                    {outcome}
                  </Badge>
                );
              })()}
              {a.metadata.labels?.["factory.ai-dlc.io/replay"] && (
                <Badge variant="outline" color="grape" size="xs">
                  replay
                </Badge>
              )}
              {superseded(a) && (
                <Tooltip label="Replaced by a restart; no longer used as agent input">
                  <Badge variant="outline" color="gray" size="xs">
                    superseded
                  </Badge>
                </Tooltip>
              )}
              <Text size="sm">by {a.spec.producedBy?.agentRef.name}</Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {a.spec.producedBy?.agentRunRef.name}
              </Text>
              <NoteCount notes={d.feedback.filter((f) => f.feedback.spec.targetRef.name === a.metadata.name)} />
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <ArtifactBody d={d} a={a} />
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
    </Stack>
  );
}

/** Rendered artifact content: select text to ask its agent or leave a feedback note (ADR-0071). */
function ArtifactBody({ d, a }: { d: WorkItemDetail; a: Artifact }) {
  return (
    <AnnotatedArtifact detail={d} artifact={a.metadata.name}>
      <MarkdownView>{ticketDraftMarkdown(a) ?? a.spec.content}</MarkdownView>
    </AnnotatedArtifact>
  );
}

function FeedbackPlanHint({ d }: { d: WorkItemDetail }) {
  const plan = d.feedbackPlan;
  if (!plan) return null;
  const gate = plan.approval ? d.approvals.find((a) => a.metadata.name === plan.approval)?.spec.stage : undefined;
  return (
    <>
      {plan.action === "reject"
        ? `Submitting requests changes at the ${gate ?? "open"} gate (rejects it): ${plan.stage} re-runs`
        : `Submitting restarts the item from ${plan.stage} (later output is kept as superseded history)`}
      , and {plan.agents.join(", ")} get{plan.agents.length === 1 ? "s" : ""} your notes with the version you read.
    </>
  );
}

function SubmitFeedbackButton({ d, onDone }: { d: WorkItemDetail; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const n = d.feedback.filter((f) => f.state === "draft").length;
  return (
    <Button
      size="xs"
      loading={busy}
      disabled={!d.feedbackPlan}
      leftSection={<IconSend size={14} />}
      onClick={async () => {
        setBusy(true);
        await act(`/api/workitems/${d.workItem.metadata.name}/feedback/submit`, {}, `${n} note${n === 1 ? "" : "s"} submitted`);
        setBusy(false);
        onDone?.();
      }}
    >
      Submit {n} note{n === 1 ? "" : "s"}
    </Button>
  );
}

// The Feedback panel lives in the (often collapsed) details section; this bar keeps drafts visible and submittable.
function FeedbackSubmitBar({ d, withPlan = 0 }: { d: WorkItemDetail; withPlan?: number }) {
  const [open, setOpen] = useState(false);
  const drafts = d.feedback.filter((f) => f.state === "draft");
  if (!drafts.length) return null;
  return (
    <Alert color="yellow" variant="light" p="sm" icon={<IconSend size={18} />}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          <strong>{drafts.length} feedback note{drafts.length === 1 ? "" : "s"}</strong> not yet sent to the agent.{" "}
          {d.feedbackPlan ? <FeedbackPlanHint d={d} /> : "Nothing can be re-run for them right now."}
          {withPlan > 0 && ` To send ${withPlan === drafts.length ? "them" : `the ${withPlan} on the plan`} together with decision answers or requested changes, submit those in the plan below: the notes go along in the same planner run.`}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setOpen(true)}>Review notes</Button>
          <SubmitFeedbackButton d={d} />
        </Group>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Feedback notes" size="lg">
        <Stack gap="xs">
          {drafts.map((v) => <FeedbackNote key={v.feedback.metadata.name} v={v} editable />)}
          <Group justify="flex-end"><SubmitFeedbackButton d={d} onDone={() => setOpen(false)} /></Group>
        </Stack>
      </Modal>
    </Alert>
  );
}

function FeedbackPanel({ d, onOpenRun }: { d: WorkItemDetail; onOpenRun: (n: string) => void }) {
  const drafts = d.feedback.filter((f) => f.state === "draft");
  const sent = d.feedback.filter((f) => f.state !== "draft");
  if (!d.feedback.length) return null;
  const plan = d.feedbackPlan;
  return (
    <Card className="sf-surface" mb="md">
      <Group justify="space-between" mb={4}>
        <Title order={5}>Feedback</Title>
        {drafts.length > 0 && (
          <Badge color="yellow" variant="light">
            {drafts.length} draft{drafts.length === 1 ? "" : "s"}
          </Badge>
        )}
      </Group>
      {drafts.length > 0 && (
        <Stack gap="xs">
          {drafts.map((v) => (
            <FeedbackNote key={v.feedback.metadata.name} v={v} editable />
          ))}
          {plan && (
            <Alert color={plan.action === "reject" ? "yellow" : "blue"} p="xs" styles={ALERT_STYLES}>
              <Text size="xs"><FeedbackPlanHint d={d} /></Text>
            </Alert>
          )}
          <SubmitFeedbackButton d={d} />
        </Stack>
      )}
      {sent.length > 0 && (
        <Accordion variant="default" chevronPosition="left" mt={drafts.length ? "xs" : 0}>
          <Accordion.Item value="sent">
            <Accordion.Control>
              <Text size="xs">
                Submitted ({sent.length}) · {sent.filter((f) => f.state === "addressed").length} addressed
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                {[...sent].reverse().map((v) => (
                  <FeedbackNote key={v.feedback.metadata.name} v={v} onOpenRun={onOpenRun} />
                ))}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Card>
  );
}

function FeedbackNote({ v, editable, onOpenRun }: { v: FeedbackView; editable?: boolean; onOpenRun?: (n: string) => void }) {
  const f = v.feedback;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.spec.comment);
  return (
    <Card withBorder p="xs">
      <Group justify="space-between" gap={4} wrap="nowrap" mb={4}>
        <Text size="xs" c="dimmed" lineClamp={1}>
          to <b>{f.spec.producedBy.agentRef.name}</b> · {f.spec.producedBy.stage}
        </Text>
        {editable ? (
          <Group gap={2} wrap="nowrap">
            <ActionIcon size="sm" variant="subtle" aria-label="Edit note" onClick={() => setEditing((e) => !e)}>
              <IconPencil size={14} />
            </ActionIcon>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label="Delete note"
              onClick={() => void act(`/api/feedback/${f.metadata.name}/delete`, {})}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ) : v.state === "addressed" && v.addressedBy ? (
          <Badge size="xs" color="teal" variant="light" style={{ cursor: "pointer" }} onClick={() => onOpenRun?.(v.addressedBy!)}>
            addressed
          </Badge>
        ) : (
          <Tooltip label="Waiting for the next run of this step">
            <Badge size="xs" color="blue" variant="light">
              pending
            </Badge>
          </Tooltip>
        )}
      </Group>
      <Text size="xs" className="sf-quote" lineClamp={3}>
        {f.spec.quote}
      </Text>
      {v.outdated && (
        <Tooltip multiline w={280} label="The agent still gets the note with the version you read. Delete it if it no longer applies.">
          <Badge size="xs" mt={4} color={v.outdated.quoteFound ? "gray" : "orange"} variant="light">
            {v.outdated.quoteFound ? "older version · passage still in the current one" : "older version · passage changed"}
          </Badge>
        </Tooltip>
      )}
      {editing ? (
        <Stack gap={4} mt={4}>
          <Textarea size="xs" autosize minRows={2} value={text} onChange={(e) => setText(e.currentTarget.value)} />
          <Group gap={4} justify="flex-end">
            <Button size="compact-xs" variant="default" onClick={() => (setEditing(false), setText(f.spec.comment))}>
              Cancel
            </Button>
            <Button
              size="compact-xs"
              disabled={!text.trim()}
              onClick={async () => {
                if (await act(`/api/feedback/${f.metadata.name}/edit`, { comment: text })) setEditing(false);
              }}
            >
              Save
            </Button>
          </Group>
        </Stack>
      ) : (
        <Text size="sm" mt={4} style={{ whiteSpace: "pre-wrap" }}>
          {f.spec.comment}
        </Text>
      )}
    </Card>
  );
}

/** One entry per published PR (its latest delivery), plus the newest attempt while it is still pending or failed. */
function pullRequestMessages(outbox: OutboxMessage[], workspace: string): OutboxMessage[] {
  const messages = outbox.filter((m) => m.spec.action === "open-pull-request" && m.spec.payload.workspace === workspace)
    .sort((a, b) => (a.metadata.creationTimestamp ?? "").localeCompare(b.metadata.creationTimestamp ?? ""));
  const url = (m: OutboxMessage) => (typeof m.status?.result?.url === "string" ? m.status.result.url : undefined);
  const published = [...new Map(messages.filter(url).map((m) => [url(m)!, m])).values()];
  const newest = messages.at(-1);
  return newest && !url(newest) ? [...published, newest] : published;
}

function HumanHistory({ clarifications, approvals }: { clarifications: Clarification[]; approvals: Approval[] }) {
  if (!clarifications.length && !approvals.length) return <Text c="dimmed" size="sm">No human input yet.</Text>;
  return (
    <Stack>
      {clarifications.map((c) => (
        <Card key={c.metadata.name} withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Clarification · {c.spec.stage}
            </Text>
            <Badge color={c.spec.answers?.length ? "teal" : c.metadata.labels?.[LABEL_SUPERSEDED] ? "gray" : "orange"}>
              {c.spec.answers?.length ? "answered" : c.metadata.labels?.[LABEL_SUPERSEDED] ? "superseded by restart" : "open"}
            </Badge>
          </Group>
          {c.spec.questions.map((q, i) => (
            <Text key={i} size="sm" mt={4}>
              <b>Q:</b> {q}
              {c.spec.answers?.[i] && (
                <>
                  <br />
                  <b>A:</b> {c.spec.answers[i]} <Text span size="xs" c="dimmed">({c.spec.answeredBy})</Text>
                </>
              )}
            </Text>
          ))}
        </Card>
      ))}
      {approvals.map((a) => (
        <Card key={a.metadata.name} withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Approval · {a.spec.stage}
            </Text>
            <Badge color={a.spec.decision === "approve" ? "teal" : a.spec.decision === "reject" ? "red" : a.metadata.labels?.[LABEL_SUPERSEDED] ? "gray" : "yellow"}>
              {a.spec.decision ?? (a.metadata.labels?.[LABEL_SUPERSEDED] ? "superseded by restart" : "pending")}
            </Badge>
          </Group>
          {a.spec.comment && <Text size="sm">{a.spec.comment}</Text>}
          {a.spec.decidedBy && (
            <Text size="xs" c="dimmed">
              by {a.spec.decidedBy}
            </Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}

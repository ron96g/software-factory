"use client";
import { Alert, Badge, Box, Button, CloseButton, Group, Kbd, Loader, Popover, ScrollArea, SegmentedControl, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMessageQuestion, IconNote } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Artifact, Conversation } from "@/core/model/kinds.ts";
import { LABEL_SUPERSEDED } from "@/core/model/kinds.ts";
import type { FeedbackView, WorkItemDetail } from "@/core/ports/app.ts";
import type { TranscriptMessage } from "@/core/ports/transcripts.ts";
import { api } from "./api.ts";
import { MarkdownView } from "./markdown.tsx";

type Mode = "feedback" | "ask";
interface Selection {
  quote: string;
  x: number;
  y: number;
  range: Range;
}

const HL = { selection: "sf-selection", draft: "sf-feedback-draft", submitted: "sf-feedback-submitted" };
const hasHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** `> `-quoted passage + question: the explain responder answers about the quoted passage (ADR-0071). */
export const quotedQuestion = (quote: string, question: string) => `${quote.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n${question.trim()}`;

/**
 * Finds `quote` in the rendered text of `root`. Whitespace is ignored on both sides: `Selection.toString()` adds line
 * breaks between blocks that the DOM's text nodes don't contain.
 */
function findRange(root: HTMLElement, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, "");
  if (!needle) return null;
  const chars: { node: Text; offset: number }[] = [];
  let hay = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.data.length; i++) {
      if (/\s/.test(n.data[i])) continue;
      hay += n.data[i];
      chars.push({ node: n, offset: i });
    }
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const start = chars[at];
  const end = chars[at + needle.length - 1];
  const r = document.createRange();
  r.setStart(start.node, start.offset);
  r.setEnd(end.node, end.offset + 1);
  return r;
}

function setHighlight(name: string, ranges: Range[]) {
  if (!hasHighlights()) return;
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

/**
 * Wraps rendered artifact content: selecting text opens a small popover to leave a feedback note (collected as a draft)
 * or to ask the producing agent about the passage (read-only, the run's explain conversation).
 */
export function AnnotatableContent({
  workItem,
  artifact,
  runName,
  agentName,
  conversations,
  notes,
  feedbackDisabled,
  children,
}: {
  workItem: string;
  artifact: string;
  runName?: string;
  agentName?: string;
  /** Explain conversations of the producing run; the newest one is continued. */
  conversations: Conversation[];
  /** Feedback on this artifact (highlighted). */
  notes: FeedbackView[];
  /** Why feedback isn't possible here (e.g. a replay); asking still works. */
  feedbackDisabled?: string;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The same artifact can be shown twice (artifact list and gate panel); each copy owns its highlight ranges.
  const instance = `${artifact}#${useId()}`;
  const [sel, setSel] = useState<Selection | null>(null);
  const lastQuote = useRef("");
  const [mode, setMode] = useState<Mode>(feedbackDisabled ? "ask" : "feedback");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<string | null>(conversations.at(-1)?.metadata.name ?? null);
  const [answers, setAnswers] = useState<{ q: string; a?: TranscriptMessage; error?: string }[]>([]);

  const noteKey = notes.map((n) => `${n.feedback.metadata.name}:${n.state}`).join(",");
  const paint = useCallback(() => {
    const el = root.current;
    if (!el || !hasHighlights()) return;
    const find = (states: string[]) =>
      notes.filter((n) => states.includes(n.state)).map((n) => findRange(el, n.feedback.spec.quote)).filter((r): r is Range => !!r);
    ArtifactHighlights.set(instance, { draft: find(["draft"]), submitted: find(["submitted"]) });
    setHighlight(HL.draft, ArtifactHighlights.all("draft"));
    setHighlight(HL.submitted, ArtifactHighlights.all("submitted"));
  }, [noteKey, instance]); // noteKey stands for `notes`, whose identity changes on every refetch
  useLayoutEffect(() => {
    paint();
    // Mermaid and code blocks may render after the first paint.
    const t = setTimeout(paint, 500);
    return () => {
      clearTimeout(t);
      ArtifactHighlights.delete(instance);
      setHighlight(HL.draft, ArtifactHighlights.all("draft"));
      setHighlight(HL.submitted, ArtifactHighlights.all("submitted"));
    };
  }, [paint, instance]);

  const close = useCallback(() => {
    setSel(null);
    setAnswers([]);
    setHighlight(HL.selection, []);
  }, []);

  useEffect(() => close, [close]);

  const onSelect = () => {
    // Defer: the selection is final only after the mouse/key event has been handled.
    setTimeout(() => {
      const el = root.current;
      const s = window.getSelection();
      if (!el || !s || s.isCollapsed || !s.rangeCount) return;
      const range = s.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      const quote = s.toString().trim();
      if (quote.length < 2) return;
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const r = range.cloneRange();
      if (quote !== lastQuote.current) setText("");
      lastQuote.current = quote;
      setSel({ quote, x: Math.min(last.right, box.right) - box.left, y: last.bottom - box.top, range: r });
      setAnswers([]);
      // Keeps the passage visibly marked while the focus moves into the popover.
      setHighlight(HL.selection, [r]);
    }, 0);
  };

  async function addNote() {
    if (!sel || !text.trim()) return;
    setBusy(true);
    try {
      await api(`/api/workitems/${workItem}/feedback`, { artifact, quote: sel.quote, comment: text });
      const drafts = notes.filter((n) => n.state === "draft").length + 1;
      notifications.show({ color: "teal", message: `Note added (${drafts} draft${drafts === 1 ? "" : "s"}). Submit them together from the Feedback panel.` });
      setText("");
      window.getSelection()?.removeAllRanges();
      close();
    } catch (e) {
      notifications.show({ color: "red", title: "Could not add the note", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    if (!sel || !text.trim() || !runName) return;
    const q = text.trim();
    setBusy(true);
    setText("");
    setAnswers((a) => [...a, { q }]);
    try {
      let name = conv;
      if (!name) {
        name = (await api<Conversation>("/api/conversations", { runName })).metadata.name;
        setConv(name);
      }
      const a = await api<TranscriptMessage>(`/api/conversations/${name}/messages`, { text: quotedQuestion(sel.quote, q) });
      setAnswers((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, a } : x)));
    } catch (e) {
      setAnswers((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)));
    } finally {
      setBusy(false);
    }
  }

  const submit = () => void (mode === "feedback" ? addNote() : ask());

  return (
    <div ref={root} className="sf-annotatable" onMouseUp={onSelect} onKeyUp={(e) => e.shiftKey && onSelect()}>
      {children}
      <Popover
        opened={!!sel}
        // Controlled popovers report outside clicks and Escape through onDismiss, not onClose.
        onDismiss={close}
        position="bottom"
        withArrow
        shadow="md"
        width={440}
        trapFocus
        returnFocus={false}
        closeOnClickOutside
        closeOnEscape
      >
        <Popover.Target>
          <span style={{ position: "absolute", left: sel?.x ?? 0, top: sel?.y ?? 0, width: 1, height: 1, pointerEvents: "none" }} />
        </Popover.Target>
        <Popover.Dropdown onMouseUp={(e) => e.stopPropagation()}>
          {sel && (
            <Stack gap="xs">
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Text size="xs" className="sf-quote" lineClamp={4} style={{ flex: 1 }}>
                  {sel.quote}
                </Text>
                <CloseButton size="sm" aria-label="Close" onClick={close} />
              </Group>
              <SegmentedControl
                size="xs"
                fullWidth
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                data={[
                  { value: "feedback", label: "Feedback (changes it)", disabled: !!feedbackDisabled },
                  { value: "ask", label: "Ask (read-only)", disabled: !runName },
                ]}
              />
              {mode === "feedback" && feedbackDisabled && (
                <Alert color="gray" p="xs">
                  <Text size="xs">{feedbackDisabled}</Text>
                </Alert>
              )}
              {mode === "ask" && answers.length > 0 && (
                <ScrollArea.Autosize mah={280}>
                  <Stack gap="xs">
                    {answers.map((x, i) => (
                      <Box key={i}>
                        <Text size="xs" fw={600}>
                          {x.q}
                        </Text>
                        {x.a ? (
                          <Box fz="sm">
                            <MarkdownView>{x.a.content}</MarkdownView>
                          </Box>
                        ) : x.error ? (
                          <Text size="xs" c="red">
                            {x.error}
                          </Text>
                        ) : (
                          <Group gap={6}>
                            <Loader size="xs" type="dots" />
                            <Text size="xs" c="dimmed">
                              {agentName ?? "the agent"} is thinking…
                            </Text>
                          </Group>
                        )}
                      </Box>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              )}
              <Textarea
                data-autofocus
                autosize
                minRows={2}
                maxRows={8}
                placeholder={
                  mode === "feedback"
                    ? `What should ${agentName ?? "the agent"} change here?`
                    : `Ask ${agentName ?? "the agent"} about this passage, e.g. "Why this limit?"`
                }
                value={text}
                disabled={mode === "feedback" && !!feedbackDisabled}
                onChange={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed">
                  {mode === "feedback" ? "Collected as a draft; nothing re-runs yet." : "Answered from the run's transcript; changes nothing."}{" "}
                  <Kbd size="xs">Ctrl</Kbd>+<Kbd size="xs">Enter</Kbd>
                </Text>
                <Button
                  size="xs"
                  style={{ flexShrink: 0 }}
                  loading={busy}
                  disabled={!text.trim() || (mode === "feedback" && !!feedbackDisabled)}
                  leftSection={mode === "feedback" ? <IconNote size={14} /> : <IconMessageQuestion size={14} />}
                  onClick={submit}
                >
                  {mode === "feedback" ? "Add note" : "Ask"}
                </Button>
              </Group>
              {mode === "ask" && conv && (
                <Text size="xs" c="dimmed">
                  The conversation continues in the run&apos;s &ldquo;Ask this agent&rdquo; chat.
                </Text>
              )}
            </Stack>
          )}
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

/** Badge for an artifact header: how many notes it has. */
export function NoteCount({ notes }: { notes: FeedbackView[] }) {
  const drafts = notes.filter((n) => n.state === "draft").length;
  if (!notes.length) return null;
  return (
    <Badge size="xs" variant={drafts ? "filled" : "light"} color={drafts ? "yellow" : "teal"} leftSection={<IconNote size={10} />}>
      {drafts ? `${drafts} draft${drafts === 1 ? "" : "s"}` : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
    </Badge>
  );
}

/** Highlight registry is global (`CSS.highlights`), so ranges of all mounted artifacts are merged per state. */
const ArtifactHighlights = (() => {
  const byArtifact = new Map<string, { draft: Range[]; submitted: Range[] }>();
  return {
    set: (a: string, r: { draft: Range[]; submitted: Range[] }) => byArtifact.set(a, r),
    delete: (a: string) => byArtifact.delete(a),
    all: (k: "draft" | "submitted") => [...byArtifact.values()].flatMap((r) => r[k]),
  };
})();

const isSuperseded = (d: WorkItemDetail, a: Artifact) =>
  !!(a.metadata.labels?.[LABEL_SUPERSEDED] || d.runs.find((r) => r.metadata.name === a.spec.producedBy?.agentRunRef.name)?.metadata.labels?.[LABEL_SUPERSEDED]);

/** Any rendering of an artifact's content (artifact list, gate panel, planning workspace) becomes annotatable here. */
export function AnnotatedArtifact({ detail: d, artifact, children }: { detail: WorkItemDetail; artifact: string; children: React.ReactNode }) {
  const a = d.artifacts.find((x) => x.metadata.name === artifact);
  if (!a) return <>{children}</>;
  return (
    <AnnotatableContent
      workItem={d.workItem.metadata.name}
      artifact={a.metadata.name}
      runName={a.spec.producedBy?.agentRunRef.name}
      agentName={a.spec.producedBy?.agentRef.name}
      conversations={d.conversations.filter((c) => (c.spec.purpose ?? "explain") === "explain" && c.spec.agentRunRef?.name === a.spec.producedBy?.agentRunRef.name)}
      notes={d.feedback.filter((f) => f.feedback.spec.targetRef.name === a.metadata.name)}
      feedbackDisabled={
        a.metadata.labels?.["factory.ai-dlc.io/replay"]
          ? "This is a replay's output; replays never advance the workflow. Leave feedback on the original."
          : !a.spec.producedBy
            ? "No agent run produced this artifact."
            : isSuperseded(d, a)
              ? "This version was replaced by a restart. Leave feedback on the current version."
              : undefined
      }
    >
      {children}
    </AnnotatableContent>
  );
}

/** ADR-0073: drafts a planning revision takes along (those on its revision stage and later). */
export function travellingNotes(d: WorkItemDetail, revisionStage?: string): number {
  const order = d.stages.map((s) => s.name);
  const from = order.indexOf(revisionStage ?? "");
  return from < 0 ? 0 : d.feedback.filter((v) => v.state === "draft" && order.indexOf(v.feedback.spec.producedBy.stage) >= from).length;
}

import type { AgentRun, Approval, Artifact, OutboxMessage, ReviewVerdict, Source, WorkItem, Workspace } from "../model/kinds.ts";
import { LABEL_SUPERSEDED } from "../model/kinds.ts";
import { parsePrReviewReport, renderReviewBody, toComment, type PrReviewFinding, type PrReviewReport } from "./report.ts";
import { inlineProblem, parseDiffLines, type DiffLines } from "./diff-lines.ts";
export { parsePrReviewReport, renderReviewBody, type PrReviewFinding, type PrReviewReport } from "./report.ts";
import { DEFAULT_NAMESPACE, SYSTEM_NAMESPACE } from "../model/resource.ts";
import { nsOf, ownerRef } from "../model/meta.ts";
import {
  canPublishReview,
  type CandidateDiffReader,
  type CompiledStage,
  type ProposedArtifactCheck,
  type Lookup,
  type Outbox,
  type OutboxHandler,
  type PublicationProgress,
  type PullRequestReviewInput,
  type Redactor,
  type ResourceReader,
  type SourceConnector,
  type SourceWritePolicy,
  type StagePublisher,
} from "../ports/index.ts";
import { LABEL_REPLAY } from "../agents/replayer.ts";

export const PR_REVIEW_ACTION = "pr-review";
export const PR_REVIEW_REPORT = "pr-review-report";
/** Large enough for any reviewable pull request; findings in a truncated tail stay in the review body. */
const DIFF_BYTES = 8 * 1024 * 1024;

/** The item's pull request workspace (ADR-0094: checked out at the pinned head, base = merge-base). */
async function reviewDiff(reader: ResourceReader, diffs: CandidateDiffReader, wi: WorkItem): Promise<DiffLines | null> {
  const ns = nsOf(wi);
  const ws = (await reader.list<Workspace>("Workspace", { namespace: ns, ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: ns } }))
    .find((w) => w.spec.checkout && w.status?.phase === "Ready" && w.status.path && w.status.baseCommit);
  if (!ws) return null;
  return parseDiffLines((await diffs.diff(ws, DIFF_BYTES)).patch);
}

/** Splits findings into inline comments (on a diff line) and the rest, which stay in the review body. */
export function placeFindings(report: PrReviewReport, diff: DiffLines | null): Set<PrReviewFinding> {
  return new Set(diff ? report.findings.filter((f) => !inlineProblem(diff, f) && !(f.side === "LEFT" && f.suggestion !== undefined)) : []);
}

/**
 * ADR-0094: a finding with a line must be commentable on the pull request (GitHub rejects the whole review otherwise).
 * Checked when the reviewer finishes, so it moves the finding or drops the line in the same run.
 */
export function prReviewArtifactCheck(d: { reader: ResourceReader; diffs: CandidateDiffReader }): ProposedArtifactCheck {
  return {
    artifactType: PR_REVIEW_REPORT,
    async check(artifact) {
      if (!artifact.item.spec.pullRequest) return undefined;
      const report = parsePrReviewReport(artifact.content);
      if (!report) return undefined; // the schema check reports the shape
      const diff = await reviewDiff(d.reader, d.diffs, artifact.item);
      if (!diff) return undefined; // no pinned workspace: findings go to the body at publication
      const problems = report.findings.flatMap((f, i) => {
        if (f.line === undefined) return [];
        if (f.side === "LEFT" && f.suggestion !== undefined) return [`findings[${i}]: a suggestion replaces head lines; it can't use side LEFT`];
        const problem = inlineProblem(diff, f);
        return problem ? [`findings[${i}] (${f.path}:${f.startLine ? `${f.startLine}-` : ""}${f.line}): ${problem}`] : [];
      });
      if (!problems.length) return undefined;
      return [
        "Some findings can't be commented inline on the pull request: GitHub only accepts lines inside the diff's changed hunks.",
        ...problems.map((p) => `- ${p}`),
        "For each: point `line` (and `startLine`) at a changed line of the head version (or side LEFT for a deleted line), or remove `line` to keep it as a file-level finding in the review body. Keep the rest of the report unchanged.",
      ].join("\n");
    },
  };
}

type ReviewEvent = "approve" | "comment" | "request-changes";
const EVENT_FOR: Record<ReviewVerdict, ReviewEvent> = { accepted: "approve", "partially-accepted": "request-changes", rejected: "request-changes" };
const GITHUB_EVENT: Record<ReviewEvent, PullRequestReviewInput["event"]> = { approve: "APPROVE", comment: "COMMENT", "request-changes": "REQUEST_CHANGES" };

/**
 * The GitHub review event for a verdict: its natural event when permitted, else `comment` if permitted, else none.
 * The verdict itself is always stated in the review body, so a downgraded event never hides it.
 */
export function permittedEvent(source: Source, verdict: ReviewVerdict): ReviewEvent | undefined {
  const allowed = source.spec.writeBack?.pullRequestReviews ?? [];
  const natural = EVENT_FOR[verdict];
  return allowed.includes(natural) ? natural : allowed.includes("comment") ? "comment" : undefined;
}

export const prReviewMessageName = (workItem: string, approval: string) => `${workItem}-pr-review-${approval}`.slice(0, 200);
export const prReviewMarker = (workItem: string, approval: string) => `<!-- software-factory:pr-review:${workItem}:${approval} -->`;

const newest = <T extends { metadata: { creationTimestamp?: string } }>(list: T[]) =>
  [...list].sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))[0];

/**
 * ADR-0094 `publish.prReview`: one review per approval of `reviewStage`, from the newest current report that existed
 * when the human approved it. The verdict is the human's override, else the agent's; the source's permission limits only the GitHub event.
 */
export function prReviewPublisher(d: { reader: ResourceReader; outbox: Outbox; redactor: Redactor; diffs: CandidateDiffReader }): StagePublisher {
  return {
    async publish(wi: WorkItem, stage: CompiledStage): Promise<PublicationProgress> {
      const cfg = stage.publish?.prReview;
      if (!cfg) return { state: "published" };
      const ns = nsOf(wi);
      const pr = wi.spec.pullRequest;
      if (!pr || !wi.spec.externalRef) return { state: "blocked", reason: "this item has no pull request to review" };
      const owned = { namespace: ns, ownedBy: { kind: "WorkItem", name: wi.metadata.name, namespace: ns } };

      const approval = newest((await d.reader.list<Approval>("Approval", owned))
        .filter((a) => a.spec.stage === cfg.reviewStage && a.spec.decision === "approve" && !a.metadata.labels?.[LABEL_SUPERSEDED]));
      if (!approval) return { state: "blocked", reason: `no approved ${cfg.reviewStage} decision to publish` };
      const key = prReviewMessageName(wi.metadata.name, approval.metadata.name);
      const sent = await d.reader.get<OutboxMessage>("OutboxMessage", ns, key);
      if (sent) {
        const phase = sent.status?.phase;
        if (phase === "Delivered") return { state: "published", message: `review posted${typeof sent.status?.result?.url === "string" ? `: ${sent.status.result.url}` : ""}` };
        if (phase === "Failed") return { state: "blocked", reason: `posting the review failed: ${sent.status?.lastError ?? "see the outbox"}. Restart from ${cfg.reviewStage} to retry.` };
        return { state: "pending" };
      }

      const runs = await d.reader.list<AgentRun>("AgentRun", owned);
      const stale = new Set(runs.filter((r) => r.spec.replayOf || r.metadata.labels?.[LABEL_REPLAY] || r.metadata.labels?.[LABEL_SUPERSEDED]).map((r) => r.metadata.name));
      const approvedAt = approval.metadata.creationTimestamp ?? "";
      const artifact = newest((await d.reader.list<Artifact>("Artifact", owned)).filter((a) =>
        a.spec.artifactTypeRef.name === cfg.artifactRef.name && !a.metadata.labels?.[LABEL_REPLAY] && !a.metadata.labels?.[LABEL_SUPERSEDED] &&
        !stale.has(a.spec.producedBy?.agentRunRef.name ?? "") && (a.metadata.creationTimestamp ?? "") <= approvedAt));
      if (!artifact) return { state: "blocked", reason: `no ${cfg.artifactRef.name} was approved at ${cfg.reviewStage}` };
      const report = parsePrReviewReport(artifact.spec.content);
      if (!report) return { state: "blocked", reason: `${artifact.metadata.name} is not a valid ${cfg.artifactRef.name}` };

      const sourceName = wi.spec.sourceRef.name;
      const source = await d.reader.get<Source>("Source", ns, sourceName) ?? await d.reader.get<Source>("Source", SYSTEM_NAMESPACE, sourceName) ??
        await d.reader.get<Source>("Source", DEFAULT_NAMESPACE, sourceName);
      if (!source) return { state: "blocked", reason: `source ${sourceName} not found` };
      const override = approval.spec.prReview?.verdict;
      const requested = override ?? report.verdict;
      const event = permittedEvent(source, requested);
      if (!event) return { state: "blocked", reason: `source "${sourceName}" does not permit posting a review for "${requested}" (writeBack.pullRequestReviews)` };

      const marker = prReviewMarker(wi.metadata.name, approval.metadata.name);
      // Placed once, when the message is enqueued: the payload is what is posted on every retry.
      const inline = placeFindings(report, await reviewDiff(d.reader, d.diffs, wi));
      const by = override && override !== report.verdict ? approval.spec.decidedBy ?? "a human" : undefined;
      await d.outbox.enqueue({
        key, namespace: ns, source: sourceName, externalId: wi.spec.externalRef.id, action: PR_REVIEW_ACTION, owner: ownerRef(wi),
        payload: {
          commitSha: pr.headSha, event: GITHUB_EVENT[event], verdict: requested, marker,
          ...(event !== EVENT_FOR[requested] ? { downgradedFrom: EVENT_FOR[requested] } : {}),
          body: d.redactor.redact(renderReviewBody(report, requested, by, inline)),
          comments: [...inline].map((f) => { const c = toComment(f); return { ...c, body: d.redactor.redact(c.body) }; }),
          fallbackBody: d.redactor.redact(renderReviewBody(report, requested, by, new Set())),
          artifact: { name: artifact.metadata.name, resourceVersion: artifact.metadata.resourceVersion },
        },
      });
      return { state: "pending" };
    },
  };
}

/** Outbox action `pr-review`: idempotent by the marker lookup inside the connector. */
export function prReviewHandler(connectors: Lookup<SourceConnector>): OutboxHandler {
  return {
    action: PR_REVIEW_ACTION,
    async deliver({ source, externalId, payload }) {
      if (!source || !externalId) throw new Error("a pull request review needs a source item");
      const c = connectors.get(source.spec.type);
      if (!c || !canPublishReview(c)) throw new Error(`source type "${source.spec.type}" cannot publish pull request reviews`);
      const event = payload.event as PullRequestReviewInput["event"];
      if (!["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(event)) throw new Error(`invalid review event ${String(event)}`);
      const comments = Array.isArray(payload.comments) ? payload.comments as PullRequestReviewInput["comments"] : undefined;
      const r = await c.publishReview(source, externalId, {
        commitSha: String(payload.commitSha), event, body: String(payload.body ?? ""), marker: String(payload.marker),
        ...(comments?.length ? { comments, fallbackBody: String(payload.fallbackBody ?? payload.body ?? "") } : {}),
      });
      return { id: r.id, url: r.url, event: r.event, existing: r.existing, ...(r.inlineComments !== undefined ? { inlineComments: r.inlineComments } : {}), ...(r.event !== event && !r.existing ? { downgradedFrom: event } : {}) };
    },
  };
}

export const prReviewPolicy: SourceWritePolicy = {
  check: (s) => (s.spec.writeBack?.pullRequestReviews?.length ? undefined : "pull request reviews are not permitted (writeBack.pullRequestReviews)"),
};

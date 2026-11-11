import type { Artifact, Repository, WorkItem, Workspace } from "../model/kinds.ts";
import { DEFAULT_NAMESPACE } from "../model/resource.ts";
import type { BranchPublisher, CodeHost, OutboxHandler, ResourceReader } from "../ports/index.ts";
import { resolveRef } from "../refs/refs.ts";

const section = (title: string, body?: string, max = 2500) => (body ? `### ${title}\n\n${body.length > max ? `${body.slice(0, max)}\n…` : body}\n` : "");

/**
 * Outbox action "open-pull-request" (ADR-0023): commit + push the workspace branch, then open/reuse a draft PR.
 * Idempotent: re-delivery finds the pushed branch and the existing PR.
 */
export function pullRequestHandler(d: { reader: ResourceReader; publisher: BranchPublisher; codeHosts: CodeHost[] }): OutboxHandler {
  return {
    action: "open-pull-request",
    async deliver({ payload }) {
      const ns = DEFAULT_NAMESPACE;
      const ws = await d.reader.get<Workspace>("Workspace", ns, String(payload.workspace));
      if (!ws?.status?.path) throw new Error(`workspace ${String(payload.workspace)} not ready`);
      const repo = await resolveRef<Repository>(d.reader, "Repository", ws.spec.repositoryRef, ns);
      if (!repo) throw new Error(`repository ${ws.spec.repositoryRef.name} not found`);
      const host = d.codeHosts.find((h) => h.matches(repo));
      if (!host) throw new Error(`no code host adapter for ${repo.spec.git?.url ?? repo.metadata.name}`);
      const wi = await d.reader.get<WorkItem>("WorkItem", ns, ws.spec.workItemRef.name);
      const arts = await d.reader.list<Artifact>("Artifact", { namespace: ns, ownedBy: { kind: "WorkItem", name: ws.spec.workItemRef.name, namespace: ns } });
      const latest = (type: string) =>
        arts.filter((a) => a.spec.artifactTypeRef.name === type && !a.metadata.labels?.["factory.ai-dlc.io/replay"]).at(-1)?.spec.content;

      const title = String(payload.title ?? wi?.spec.title ?? ws.spec.workItemRef.name);
      const pushed = await d.publisher.publish(ws, repo, `${title}\n\nWork item: ${ws.spec.workItemRef.name}`);
      const body = [
        `> Opened by the **Software Factory** for work item \`${ws.spec.workItemRef.name}\`. Draft until a human approves.`,
        "",
        wi?.spec.description ?? "",
        "",
        section("Spec", latest("spec")),
        section("Verification", latest("verification-report")),
        section("Review", latest("review-report"), 1500),
        `_Base: \`${ws.status.baseCommit?.slice(0, 10)}\` · head: \`${pushed.commit.slice(0, 10)}\`_`,
      ].join("\n");
      const pr = await host.openPullRequest(repo, {
        head: pushed.branch,
        base: repo.spec.git?.defaultBranch ?? "main",
        title,
        body,
        draft: payload.draft !== false,
      });
      return { url: pr.url, number: pr.number, created: pr.created, branch: pushed.branch, commit: pushed.commit };
    },
  };
}

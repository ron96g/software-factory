import type { Source } from "../../model/kinds.ts";
import type { PullRequestReviewInput, PullRequestReviewPublisher, CommentPublisher, CommentReader, ExternalItem, ItemFetcher, SecretResolver, SourceConnector, IssueCreator, IssueFinder, IssueDraft, CreatedIssue, IssueStatus, IssueStatusReader } from "../../ports/index.ts";

type Fetch = typeof fetch;

/** Manual source: items are created through the UI. No capabilities (ISP). */
export const manualConnector: SourceConnector = { type: "manual" };

/** Internal source for monitoring feedback (v0.6). No capabilities yet. */
export const internalConnector: SourceConnector = { type: "internal" };

/** GitHub Issues: fetch, comment (via the outbox), read replies. */
export class GithubConnector implements SourceConnector, ItemFetcher, CommentPublisher, CommentReader, IssueCreator, IssueFinder, IssueStatusReader {
  readonly type: string = "github";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  private readonly apiBase: string;
  constructor(secrets: SecretResolver, f: Fetch = fetch, apiBase = "https://api.github.com") {
    this.secrets = secrets;
    this.f = f;
    this.apiBase = apiBase;
  }

  protected repo(source: Source): string {
    const repo = source.spec.connection?.repo as string | undefined;
    if (!repo) throw new Error(`source ${source.metadata.name}: spec.connection.repo is required`);
    return repo;
  }

  protected async call(source: Source, path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.secrets.resolve(source.spec.connection?.secretRef);
    const res = await this.f(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async postComment(source: Source, externalId: string, body: string): Promise<void> {
    await this.call(source, `/repos/${this.repo(source)}/issues/${externalId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }

  async listComments(source: Source, externalId: string, since?: string) {
    const q = since ? `?since=${encodeURIComponent(since)}&per_page=100` : "?per_page=100";
    const res = await this.call(source, `/repos/${this.repo(source)}/issues/${externalId}/comments${q}`);
    const list = (await res.json()) as { user: { login: string }; body: string; created_at: string }[];
    return list.map((c) => ({ author: c.user.login, body: c.body ?? "", createdAt: c.created_at }));
  }

  async createIssue(source: Source, draft: IssueDraft): Promise<CreatedIssue> {
    const cfg = source.spec.writeBack?.issues;
    if (!cfg) throw new Error(`source ${source.metadata.name} is read-only for issues: refusing POST`);
    const labels = [...new Set([...(cfg.labels ?? []), ...(draft.labels ?? [])])];
    const res = await this.call(source, `/repos/${this.repo(source)}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: draft.title, body: `${draft.body}\n\n${draft.marker}`, ...(labels.length ? { labels } : {}) }),
    });
    const issue = (await res.json()) as { number?: number; html_url?: string };
    if (typeof issue.number !== "number") throw new Error("GitHub did not return an issue number; delivery outcome requires verification");
    return { externalId: String(issue.number), url: issue.html_url };
  }

  async readIssueStatus(source: Source, externalId: string): Promise<IssueStatus> {
    const res = await this.call(source, `/repos/${this.repo(source)}/issues/${encodeURIComponent(externalId)}`);
    const i = (await res.json()) as { state?: string; state_reason?: string | null; assignee?: { login?: string } | null; updated_at?: string };
    if (!i.state) throw new Error("GitHub returned an issue without state");
    return { state: i.state_reason ? `${i.state} (${i.state_reason})` : i.state, open: i.state === "open", assignee: i.assignee?.login, updatedAt: i.updated_at };
  }

  async findCreatedIssues(source: Source, query: { marker: string; createdAfter: string }): Promise<CreatedIssue[]> {
    const me = (await (await this.call(source, "/user")).json()) as { login?: string };
    if (!me.login) throw new Error("GitHub did not identify the token user");
    const res = await this.call(source, `/repos/${this.repo(source)}/issues?state=all&sort=created&direction=desc&since=${encodeURIComponent(query.createdAfter)}&per_page=100`);
    const issues = (await res.json()) as { number: number; html_url: string; body: string | null; user: { login: string }; created_at: string; pull_request?: unknown }[];
    return issues
      .filter((i) => !i.pull_request && i.user?.login === me.login && i.created_at >= query.createdAfter && (i.body ?? "").includes(query.marker))
      .map((i) => ({ externalId: String(i.number), url: i.html_url }));
  }

  async fetchItems(source: Source): Promise<ExternalItem[]> {
    const labels = ((source.spec.sync?.filter?.labels as string[] | undefined) ?? []).join(",");
    const res = await this.call(source, `/repos/${this.repo(source)}/issues?state=open&per_page=50${labels ? `&labels=${encodeURIComponent(labels)}` : ""}`);
    const issues = (await res.json()) as {
      number: number;
      html_url: string;
      title: string;
      body: string | null;
      labels: { name: string }[];
      updated_at: string;
      pull_request?: unknown;
    }[];
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        externalId: String(i.number),
        url: i.html_url,
        title: i.title,
        description: i.body ?? "",
        labels: i.labels.map((l) => l.name),
        updatedAt: i.updated_at,
      }));
  }
}

/**
 * ADR-0094: GitHub pull requests as a source (`github-pr`). Imports open, label-filtered PRs pinned at their head and
 * posts one review per approved verdict. Issue capabilities are not exposed: this source never creates issues.
 */
export class GithubPullRequestConnector implements SourceConnector, ItemFetcher, CommentPublisher, CommentReader, PullRequestReviewPublisher {
  readonly type = "github-pr";
  private readonly gh: GithubAccess;
  constructor(secrets: SecretResolver, f: Fetch = fetch, apiBase = "https://api.github.com") {
    this.gh = new GithubAccess(secrets, f, apiBase);
  }

  postComment(source: Source, externalId: string, body: string) {
    return this.gh.postComment(source, externalId, body);
  }

  listComments(source: Source, externalId: string, since?: string) {
    return this.gh.listComments(source, externalId, since);
  }

  async fetchItems(source: Source): Promise<ExternalItem[]> {
    const wanted = (source.spec.sync?.filter?.labels as string[] | undefined) ?? [];
    const res = await this.gh.request(source, `/repos/${this.gh.repoOf(source)}/pulls?state=open&per_page=50`);
    const pulls = (await res.json()) as {
      number: number; html_url: string; title: string; body: string | null; labels: { name: string }[]; updated_at: string; draft?: boolean;
      head: { sha: string }; base: { ref: string };
    }[];
    // The pulls API has no label filter: every wanted label must be present (same semantics as the issues API).
    return pulls
      .filter((p) => wanted.every((l) => p.labels.some((x) => x.name === l)))
      .map((p) => ({
        externalId: String(p.number),
        url: p.html_url,
        title: p.title,
        description: p.body ?? "",
        labels: p.labels.map((l) => l.name),
        updatedAt: p.updated_at,
        pullRequest: { number: p.number, headSha: p.head.sha, baseRef: p.base.ref },
      }));
  }

  async publishReview(source: Source, externalId: string, review: PullRequestReviewInput) {
    const base = `/repos/${this.gh.repoOf(source)}/pulls/${encodeURIComponent(externalId)}/reviews`;
    // Claim by lookup: a retry after a lost response finds the review it already posted.
    const existing = await this.findReview(source, base, review.marker);
    if (existing) return { ...existing, existing: true };
    const post = (event: PullRequestReviewInput["event"], inline: boolean) => this.gh.request(source, base, { method: "POST", body: JSON.stringify({
      commit_id: review.commitSha, event,
      body: `${inline ? review.body : review.fallbackBody ?? review.body}\n\n${review.marker}`,
      ...(inline && review.comments?.length ? { comments: review.comments } : {}),
    }) });
    const unprocessable = (e: unknown) => e instanceof Error && e.message.startsWith("GitHub 422");
    // A 422 creates nothing, so each fallback is safe: first without inline comments (a line GitHub can't resolve),
    // then as COMMENT (GitHub refuses APPROVE / REQUEST_CHANGES on the token owner's own pull request).
    const attempts: [PullRequestReviewInput["event"], boolean][] = [[review.event, true]];
    if (review.comments?.length) attempts.push([review.event, false]);
    if (review.event !== "COMMENT") attempts.push(["COMMENT", !!review.comments?.length], ["COMMENT", false]);
    for (const [i, [event, inline]] of attempts.entries()) {
      let res: Response;
      try {
        res = await post(event, inline);
      } catch (e) {
        if (unprocessable(e) && i < attempts.length - 1) continue;
        throw e;
      }
      const r = (await res.json()) as { id?: number; html_url?: string };
      if (typeof r.id !== "number") throw new Error("GitHub did not return a review id; delivery outcome requires verification");
      return { id: String(r.id), url: r.html_url, event, existing: false, inlineComments: inline ? review.comments?.length ?? 0 : 0 };
    }
    throw new Error("unreachable");
  }

  private async findReview(source: Source, path: string, marker: string) {
    for (let page = 1; page <= 10; page++) {
      const list = (await (await this.gh.request(source, `${path}?per_page=100&page=${page}`)).json()) as { id: number; html_url?: string; body?: string | null; state?: string }[];
      const hit = list.find((r) => (r.body ?? "").includes(marker));
      if (hit) return { id: String(hit.id), url: hit.html_url, event: hit.state ?? "COMMENTED" };
      if (list.length < 100) return undefined;
    }
    return undefined;
  }
}

/** GitHub REST access shared by the connectors (the issue connector's request plumbing, without its capabilities). */
class GithubAccess extends GithubConnector {
  repoOf(source: Source) {
    return this.repo(source);
  }
  request(source: Source, path: string, init?: RequestInit) {
    return this.call(source, path, init);
  }
}

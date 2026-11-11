import type { Source } from "../../model/kinds.ts";
import type { CommentPublisher, CommentReader, ExternalItem, ItemFetcher, SecretResolver, SourceConnector } from "../../ports/index.ts";

type Fetch = typeof fetch;

/** Manual source: items are created through the UI. No capabilities (ISP). */
export const manualConnector: SourceConnector = { type: "manual" };

/** Internal source for monitoring feedback (v0.6). No capabilities yet. */
export const internalConnector: SourceConnector = { type: "internal" };

/** GitHub Issues: fetch, comment (via the outbox), read replies. */
export class GithubConnector implements SourceConnector, ItemFetcher, CommentPublisher, CommentReader {
  readonly type = "github";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  private readonly apiBase: string;
  constructor(secrets: SecretResolver, f: Fetch = fetch, apiBase = "https://api.github.com") {
    this.secrets = secrets;
    this.f = f;
    this.apiBase = apiBase;
  }

  private repo(source: Source): string {
    const repo = source.spec.connection?.repo as string | undefined;
    if (!repo) throw new Error(`source ${source.metadata.name}: spec.connection.repo is required`);
    return repo;
  }

  private async call(source: Source, path: string, init: RequestInit = {}): Promise<Response> {
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

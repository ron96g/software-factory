import type { Source } from "../../model/kinds.ts";
import type { ExternalItem, ItemFetcher, SecretResolver, SourceConnector } from "../../ports/index.ts";

type Fetch = typeof fetch;

/** Manual source: items are created through the UI. No capabilities (ISP). */
export const manualConnector: SourceConnector = { type: "manual" };

/** Internal source for monitoring feedback (v0.6). No capabilities yet. */
export const internalConnector: SourceConnector = { type: "internal" };

/** GitHub Issues: fetch only in the MVP. Comment publishing comes with the outbox in v0.2. */
export class GithubConnector implements SourceConnector, ItemFetcher {
  readonly type = "github";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  private readonly apiBase: string;
  constructor(secrets: SecretResolver, f: Fetch = fetch, apiBase = "https://api.github.com") {
    this.secrets = secrets;
    this.f = f;
    this.apiBase = apiBase;
  }

  async fetchItems(source: Source): Promise<ExternalItem[]> {
    const repo = source.spec.connection?.repo as string | undefined;
    if (!repo) throw new Error(`source ${source.metadata.name}: spec.connection.repo is required`);
    const labels = ((source.spec.sync?.filter?.labels as string[] | undefined) ?? []).join(",");
    const token = this.secrets.resolve(source.spec.connection?.secretRef);
    const url = `${this.apiBase}/repos/${repo}/issues?state=open&per_page=50${labels ? `&labels=${encodeURIComponent(labels)}` : ""}`;
    const res = await this.f(url, {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

import type { Source } from "../../model/kinds.ts";
import type { CommentPublisher, CommentReader, ExternalItem, ItemFetcher, SecretResolver, SourceConnector } from "../../ports/index.ts";

type Fetch = typeof fetch;
type Adf = { type?: string; text?: string; content?: Adf[] };

/** Atlassian Document Format → plain text (enough for prompts and answers). */
export function adfToText(node: Adf | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfToText).join(node.type === "doc" ? "\n\n" : "");
  return node.type === "paragraph" || node.type === "listItem" ? inner.trim() : inner;
}

const textToAdf = (text: string) => ({
  type: "doc",
  version: 1,
  content: text.split(/\n{2,}/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
});

/**
 * Jira Cloud (REST v3). Auth: basic `connection.email` + API token from `connection.secretRef` (ADR-0015).
 * Filter: `sync.filter.jql`.
 */
export class JiraConnector implements SourceConnector, ItemFetcher, CommentPublisher, CommentReader {
  readonly type = "jira";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  constructor(secrets: SecretResolver, f: Fetch = fetch) {
    this.secrets = secrets;
    this.f = f;
  }

  private async call(source: Source, path: string, init: RequestInit = {}): Promise<Response> {
    const base = String(source.spec.connection?.url ?? "").replace(/\/$/, "");
    if (!base) throw new Error(`source ${source.metadata.name}: spec.connection.url is required`);
    const email = source.spec.connection?.email as string | undefined;
    const token = this.secrets.resolve(source.spec.connection?.secretRef);
    const auth: Record<string, string> = email && token ? { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` } : {};
    const res = await this.f(`${base}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...auth },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async fetchItems(source: Source): Promise<ExternalItem[]> {
    const project = source.spec.connection?.project as string | undefined;
    const jql = (source.spec.sync?.filter?.jql as string | undefined) ?? (project ? `project = ${project} AND statusCategory != Done` : "");
    if (!jql) throw new Error(`source ${source.metadata.name}: sync.filter.jql or connection.project is required`);
    const res = await this.call(source, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description,labels,priority,updated`);
    const body = (await res.json()) as {
      issues: { key: string; self: string; fields: { summary: string; description: Adf | null; labels?: string[]; priority?: { name: string }; updated: string } }[];
    };
    const base = String(source.spec.connection?.url).replace(/\/$/, "");
    return body.issues.map((i) => ({
      externalId: i.key,
      url: `${base}/browse/${i.key}`,
      title: i.fields.summary,
      description: adfToText(i.fields.description),
      labels: i.fields.labels ?? [],
      priority: i.fields.priority?.name,
      updatedAt: i.fields.updated,
    }));
  }

  async postComment(source: Source, externalId: string, body: string): Promise<void> {
    await this.call(source, `/rest/api/3/issue/${encodeURIComponent(externalId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: textToAdf(body) }),
    });
  }

  async listComments(source: Source, externalId: string, since?: string) {
    const res = await this.call(source, `/rest/api/3/issue/${encodeURIComponent(externalId)}/comment?orderBy=created&maxResults=100`);
    const body = (await res.json()) as { comments: { author: { displayName: string }; body: Adf; created: string }[] };
    return body.comments
      .map((c) => ({ author: c.author.displayName, body: adfToText(c.body), createdAt: new Date(c.created).toISOString() }))
      .filter((c) => !since || c.createdAt >= since);
  }
}

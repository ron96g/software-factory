import type { Source } from "../../model/kinds.ts";
import type { CommentPublisher, CommentReader, ExternalItem, ItemFetcher, SecretResolver, SourceConnector, ServiceDeskCommentPublisher, ServiceDeskCommentFinder, TicketStateReader, TicketTransitionWriter, TicketState } from "../../ports/index.ts";

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
 * Wire differences between Jira Cloud and Jira Data Center/Server; everything else is shared.
 * Cloud: REST v3, basic auth (`connection.email` + API token), rich text as ADF.
 * Data Center: REST v2, Personal Access Token as Bearer, rich text as wiki-markup strings.
 */
interface JiraDialect {
  api: string;
  searchPath: string;
  auth(email: string | undefined, token: string | undefined): Record<string, string>;
  toBody(text: string): unknown;
}

const DIALECTS: Record<string, JiraDialect> = {
  cloud: {
    api: "/rest/api/3",
    searchPath: "/rest/api/3/search/jql",
    auth: (email, token): Record<string, string> => (email && token ? { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` } : {}),
    toBody: textToAdf,
  },
  datacenter: {
    api: "/rest/api/2",
    searchPath: "/rest/api/2/search",
    auth: (_email, token): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {}),
    toBody: (text) => text,
  },
};

/**
 * Jira connector. `connection.deployment`: `cloud` (default) or `datacenter`. Token from `connection.secretRef` (ADR-0015).
 * Filter: `sync.filter.jql`.
 */
export class JiraConnector implements SourceConnector, ItemFetcher, CommentPublisher, CommentReader, ServiceDeskCommentPublisher, ServiceDeskCommentFinder, TicketStateReader, TicketTransitionWriter {
  readonly type = "jira";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  constructor(secrets: SecretResolver, f: Fetch = fetch) {
    this.secrets = secrets;
    this.f = f;
  }

  private dialect(source: Source): JiraDialect {
    const deployment = String(source.spec.connection?.deployment ?? "cloud");
    const d = DIALECTS[deployment];
    if (!d) throw new Error(`source ${source.metadata.name}: unknown connection.deployment "${deployment}" (cloud | datacenter)`);
    return d;
  }

  private base(source: Source): string {
    const base = String(source.spec.connection?.url ?? "").replace(/\/$/, "");
    if (!base) throw new Error(`source ${source.metadata.name}: spec.connection.url is required`);
    return base;
  }

  private async call(source: Source, path: string, init: RequestInit = {}, permission: "comment" | "reply" | "transition" = "comment"): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const allowed = permission === "comment" ? source.spec.sync?.bidirectional
        : permission === "reply" ? Array.isArray(source.spec.writeBack?.replyVisibilities) && source.spec.writeBack.replyVisibilities.length > 0 : source.spec.writeBack?.transitions === true;
      if (!allowed) throw new Error(`source ${source.metadata.name} is read-only for ${permission}: refusing ${method} ${path}`);
    }
    const email = source.spec.connection?.email as string | undefined;
    const token = this.secrets.resolve(source.spec.connection?.secretRef);
    // Unauthenticated Data Center requests get redirected to a login page; report that instead of parsing HTML.
    const res = await this.f(`${this.base(source)}${path}`, {
      ...init,
      redirect: "manual",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...this.dialect(source).auth(email, token) },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300) || res.headers.get("location") || res.statusText}`);
    return res;
  }

  async fetchItems(source: Source): Promise<ExternalItem[]> {
    const project = source.spec.connection?.project as string | undefined;
    const jql = (source.spec.sync?.filter?.jql as string | undefined) ?? (project ? `project = ${project} AND statusCategory != Done` : "");
    if (!jql) throw new Error(`source ${source.metadata.name}: sync.filter.jql or connection.project is required`);
    const res = await this.call(source, `${this.dialect(source).searchPath}?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description,labels,priority,updated`);
    const body = (await res.json()) as {
      issues: { key: string; self: string; fields: { summary: string; description: Adf | string | null; labels?: string[]; priority?: { name: string }; updated: string } }[];
    };
    const base = this.base(source);
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
    const d = this.dialect(source);
    await this.call(source, `${d.api}/issue/${encodeURIComponent(externalId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: d.toBody(body) }),
    });
  }

  async listComments(source: Source, externalId: string, since?: string) {
    const res = await this.call(source, `${this.dialect(source).api}/issue/${encodeURIComponent(externalId)}/comment?orderBy=created&maxResults=100`);
    const body = (await res.json()) as { comments: { author: { displayName: string }; body: Adf | string; created: string }[] };
    return body.comments
      .map((c) => ({ author: c.author.displayName, body: adfToText(c.body), createdAt: new Date(c.created).toISOString() }))
      .filter((c) => !since || c.createdAt >= since);
  }

  async publishReply(source: Source, externalId: string, body: string, visibility: "public" | "internal"): Promise<{ id: string }> {
    if (!Array.isArray(source.spec.writeBack?.replyVisibilities) || !source.spec.writeBack.replyVisibilities.includes(visibility)) throw new Error(`source does not allow ${visibility} replies`);
    const res = await this.call(source, `/rest/servicedeskapi/request/${encodeURIComponent(externalId)}/comment`, {
      method: "POST", body: JSON.stringify({ body, public: visibility === "public" }),
    }, "reply");
    const reply = await res.json() as { id?: string };
    if (typeof reply.id !== "string" || !reply.id) throw new Error("Jira did not return a comment receipt; delivery outcome requires verification");
    return { id: reply.id };
  }

  async findReply(source: Source, externalId: string, marker: string, visibility: "public" | "internal") {
    let start = 0;
    for (let page = 0; page < 100; page++) {
      const res = await this.call(source, `/rest/servicedeskapi/request/${encodeURIComponent(externalId)}/comment?start=${start}&limit=100`);
      const data = await res.json() as { values: { id: string; body: string; public: boolean }[]; isLastPage: boolean };
      const match = data.values.find((c) => c.public === (visibility === "public") && c.body.includes(marker));
      if (match) return { id: match.id };
      if (data.isLastPage) return null;
      if (!data.values.length) throw new Error("Jira returned an empty non-final comment page");
      start += data.values.length;
    }
    throw new Error("Jira receipt search exceeded 10,000 comments; verify delivery manually");
  }

  async ticketState(source: Source, externalId: string): Promise<TicketState> {
    const path = `${this.dialect(source).api}/issue/${encodeURIComponent(externalId)}`;
    const issue = await (await this.call(source, `${path}?fields=status`)).json() as { fields: { status: { id: string; name: string } } };
    const data = await (await this.call(source, `${path}/transitions?expand=transitions.fields`)).json() as {
      transitions: { id: string; name: string; to: { id: string; name: string }; fields?: Record<string, { required?: boolean; hasDefaultValue?: boolean }> }[];
    };
    if (!issue.fields.status?.id || !issue.fields.status.name || !Array.isArray(data.transitions)) throw new Error("Jira returned invalid ticket state/transitions");
    return { ...issue.fields.status, transitions: data.transitions.map((t) => ({
      id: t.id, name: t.name, to: t.to,
      requiresFields: Object.values(t.fields ?? {}).some((f) => f.required && !f.hasDefaultValue),
    })) };
  }

  async transitionTicket(source: Source, externalId: string, transitionId: string): Promise<void> {
    await this.call(source, `${this.dialect(source).api}/issue/${encodeURIComponent(externalId)}/transitions`, {
      method: "POST", body: JSON.stringify({ transition: { id: transitionId } }),
    }, "transition");
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubConnector } from "./connectors.ts";
import { JiraConnector, adfToText } from "./jira.ts";
import { markdownToAdf, markdownToWiki } from "./markdownToJira.ts";

type Call = { url: string; method: string; body?: any };
function fake(responses: (call: Call) => unknown) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return Response.json(responses(call));
  }) as unknown as typeof fetch;
  return { calls, f };
}
const secrets = { resolve: () => "tok" };
const MARKER = "<!-- factory-issue:uid-1 -->";
const gh = { metadata: { name: "gh" }, spec: { type: "github", connection: { repo: "o/r" }, writeBack: { issues: { labels: ["factory"] } } } } as never;
const jira = (deployment: string, issues: object | undefined = { project: "DHEI", issueType: "Task" }) =>
  ({ metadata: { name: "j" }, spec: { type: "jira", connection: { url: "https://j.example", deployment }, writeBack: issues ? { issues } : {} } }) as never;

test("U2: GitHub createIssue posts title, marker body and labels", async () => {
  const { calls, f } = fake(() => ({ number: 7, html_url: "https://github.com/o/r/issues/7" }));
  const r = await new GithubConnector(secrets, f).createIssue(gh, { title: "T", body: "B", labels: ["x"], marker: MARKER });
  assert.deepEqual(r, { externalId: "7", url: "https://github.com/o/r/issues/7" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.body, `B\n\n${MARKER}`);
  assert.deepEqual(calls[0].body.labels, ["factory", "x"]);
});

test("U2: GitHub createIssue refuses a source without writeBack.issues", async () => {
  const { calls, f } = fake(() => ({}));
  const ro = { metadata: { name: "ro" }, spec: { type: "github", connection: { repo: "o/r" } } } as never;
  await assert.rejects(new GithubConnector(secrets, f).createIssue(ro, { title: "T", body: "B", marker: MARKER }));
  assert.equal(calls.length, 0);
});

test("U2: GitHub findCreatedIssues matches own account, marker and creation time only", async () => {
  const { calls, f } = fake((c) => c.url.endsWith("/user") ? { login: "bot" } : [
    { number: 1, html_url: "u1", body: `x ${MARKER}`, user: { login: "bot" }, created_at: "2026-01-02T00:00:00Z" },
    { number: 2, html_url: "u2", body: `x ${MARKER}`, user: { login: "human" }, created_at: "2026-01-02T00:00:00Z" },
    { number: 3, html_url: "u3", body: "no marker", user: { login: "bot" }, created_at: "2026-01-02T00:00:00Z" },
    { number: 4, html_url: "u4", body: `x ${MARKER}`, user: { login: "bot" }, created_at: "2025-12-31T00:00:00Z" },
    { number: 5, html_url: "u5", body: `x ${MARKER}`, user: { login: "bot" }, created_at: "2026-01-02T00:00:00Z", pull_request: {} },
  ]);
  const r = await new GithubConnector(secrets, f).findCreatedIssues(gh, { marker: MARKER, createdAfter: "2026-01-01T00:00:00Z" });
  assert.deepEqual(r, [{ externalId: "1", url: "u1" }]);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("U2: Jira Cloud createIssue sends ADF; Data Center sends wiki markup", async () => {
  const md = "# Head\n\nSome **bold** and `code`\n\n- a\n- b";
  const cloud = fake(() => ({ key: "DHEI-1" }));
  const r = await new JiraConnector(secrets, cloud.f).createIssue(jira("cloud"), { title: "T", body: md, labels: ["l"], marker: MARKER });
  assert.deepEqual(r, { externalId: "DHEI-1", url: "https://j.example/browse/DHEI-1" });
  assert.equal(cloud.calls[0].url, "https://j.example/rest/api/3/issue");
  assert.equal(cloud.calls[0].body.fields.project.key, "DHEI");
  assert.equal(cloud.calls[0].body.fields.issuetype.name, "Task");
  assert.equal(cloud.calls[0].body.fields.description.type, "doc");
  assert.match(adfToText(cloud.calls[0].body.fields.description), /factory-issue:uid-1/);

  const dc = fake(() => ({ key: "DHEI-2" }));
  await new JiraConnector(secrets, dc.f).createIssue(jira("datacenter"), { title: "T", body: md, marker: MARKER });
  assert.equal(dc.calls[0].url, "https://j.example/rest/api/2/issue");
  assert.equal(typeof dc.calls[0].body.fields.description, "string");
  assert.match(dc.calls[0].body.fields.description, /^h1\. Head/);
});

test("U2: Jira createIssue is refused without writeBack.issues and needs a configured project", async () => {
  const { calls, f } = fake(() => ({ key: "X-1" }));
  const c = new JiraConnector(secrets, f);
  await assert.rejects(c.createIssue({ metadata: { name: "ro" }, spec: { type: "jira", connection: { url: "https://j.example" } } } as never, { title: "T", body: "B", marker: MARKER }));
  await assert.rejects(c.createIssue(jira("cloud", {}), { title: "T", body: "B", marker: MARKER }), /project is required/);
  assert.equal(calls.length, 0);
});

test("U2: Jira findCreatedIssues searches by project, reporter and time, then checks the marker", async () => {
  const { calls, f } = fake(() => ({ issues: [
    { key: "DHEI-1", fields: { description: `hi ${MARKER}` } },
    { key: "DHEI-2", fields: { description: "other" } },
    { key: "DHEI-3", fields: { description: null } },
  ] }));
  const r = await new JiraConnector(secrets, f).findCreatedIssues(jira("datacenter"), { marker: MARKER, createdAfter: "2026-01-02T03:04:05Z" });
  assert.deepEqual(r, [{ externalId: "DHEI-1", url: "https://j.example/browse/DHEI-1" }]);
  const jql = decodeURIComponent(calls[0].url);
  assert.match(jql, /^https:\/\/j\.example\/rest\/api\/2\/search\?/);
  assert.match(jql, /project = "DHEI" AND reporter = currentUser\(\) AND created >= "2026\/01\/02 03:04"/);
  assert.equal(calls[0].method, "GET");
});

test("U2: Markdown converters", () => {
  const adf = markdownToAdf("## H\n\ntext [l](https://x.io) *i*\n\n1. one\n2. two\n\n```ts\nlet a=1;\n```");
  assert.deepEqual(adf.content.map((n) => n.type), ["heading", "paragraph", "orderedList", "codeBlock"]);
  assert.equal(adf.content[0].attrs?.level, 2);
  assert.equal(adf.content[3].attrs?.language, "ts");
  assert.equal(markdownToWiki("## H\n[l](https://x.io) **b** *i* `c`\n1. one\n- two\n```ts\nx\n```"),
    "h2. H\n[l|https://x.io] *b* _i_ {{c}}\n# one\n* two\n{code:ts}\nx\n{code}");
});

test("U2: Jira comment bodies stay plain text, unchanged by the converter", async () => {
  const cloud = fake(() => ({}));
  await new JiraConnector(secrets, cloud.f).postComment({ metadata: { name: "j" }, spec: { type: "jira", connection: { url: "https://j.example" }, sync: { bidirectional: true } } } as never, "X-1", "a **b**\n\nc");
  assert.deepEqual(cloud.calls[0].body.body, { type: "doc", version: 1, content: [
    { type: "paragraph", content: [{ type: "text", text: "a **b**" }] }, { type: "paragraph", content: [{ type: "text", text: "c" }] }] });
  const dc = fake(() => ({}));
  await new JiraConnector(secrets, dc.f).postComment({ metadata: { name: "j" }, spec: { type: "jira", connection: { url: "https://j.example", deployment: "datacenter" }, sync: { bidirectional: true } } } as never, "X-1", "a **b**");
  assert.equal(dc.calls[0].body.body, "a **b**");
});

test("U1: Jira readIssueStatus is a GET and maps open/closed", async () => {
  const open = fake(() => ({ fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, assignee: { displayName: "Ann" }, updated: "2026-02-01T00:00:00Z", resolution: null } }));
  const r = await new JiraConnector(secrets, open.f).readIssueStatus(jira("cloud"), "DHEI-1");
  assert.deepEqual(r, { state: "In Progress", open: true, assignee: "Ann", updatedAt: "2026-02-01T00:00:00Z" });
  assert.equal(open.calls[0].method, "GET");
  assert.match(open.calls[0].url, /\/rest\/api\/3\/issue\/DHEI-1\?fields=/);
  const done = fake(() => ({ fields: { status: { name: "Done", statusCategory: { key: "done" } }, assignee: null } }));
  assert.equal((await new JiraConnector(secrets, done.f).readIssueStatus(jira("cloud"), "DHEI-1")).open, false);
  const resolved = fake(() => ({ fields: { status: { name: "Closed", statusCategory: { key: "indeterminate" } }, resolution: { name: "Fixed" } } }));
  assert.equal((await new JiraConnector(secrets, resolved.f).readIssueStatus(jira("cloud"), "DHEI-1")).open, false);
});

test("U1: GitHub readIssueStatus maps state and assignee", async () => {
  const { calls, f } = fake(() => ({ state: "closed", state_reason: "completed", assignee: { login: "bob" }, updated_at: "2026-02-01T00:00:00Z" }));
  const r = await new GithubConnector(secrets, f).readIssueStatus(gh, "7");
  assert.deepEqual(r, { state: "closed (completed)", open: false, assignee: "bob", updatedAt: "2026-02-01T00:00:00Z" });
  assert.equal(calls[0].method, "GET");
});

test("U1: Jira linkIssues posts a Relates link and is refused without writeBack.issues", async () => {
  const { calls, f } = fake(() => ({}));
  const c = new JiraConnector(secrets, f);
  await c.linkIssues(jira("datacenter"), "DHEI-2", "SDDHEI-11446");
  assert.equal(calls[0].url, "https://j.example/rest/api/2/issueLink");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { type: { name: "Relates" }, inwardIssue: { key: "DHEI-2" }, outwardIssue: { key: "SDDHEI-11446" } });
  await assert.rejects(c.linkIssues({ metadata: { name: "ro" }, spec: { type: "jira", connection: { url: "https://j.example" } } } as never, "A-1", "B-1"), /read-only/);
  assert.equal(calls.length, 1);
});

import type { Repository } from "../../model/kinds.ts";
import type { CodeHost, PullRequestInput, SecretResolver } from "../../ports/index.ts";

type Fetch = typeof fetch;

const parse = (url: string | undefined) => {
  const m = url ? /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url) : null;
  return m ? { owner: m[1], repo: m[2] } : null;
};

/** GitHub code host (ADR-0023): opens draft PRs, reusing an existing open PR for the same head branch. */
export class GithubCodeHost implements CodeHost {
  readonly type = "github";
  private readonly secrets: SecretResolver;
  private readonly f: Fetch;
  private readonly api: string;
  constructor(secrets: SecretResolver, f: Fetch = fetch, api = "https://api.github.com") {
    this.secrets = secrets;
    this.f = f;
    this.api = api;
  }

  matches(repo: Repository): boolean {
    return !!parse(repo.spec.git?.url);
  }

  private async call(repo: Repository, path: string, init: RequestInit = {}) {
    const token = this.secrets.resolve(repo.spec.git?.secretRef);
    const res = await this.f(`${this.api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async openPullRequest(repo: Repository, input: PullRequestInput) {
    const r = parse(repo.spec.git?.url);
    if (!r) throw new Error(`repository ${repo.metadata.name} is not a GitHub repository`);
    const existing = (await this.call(repo, `/repos/${r.owner}/${r.repo}/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${input.head}`)}`)) as {
      html_url: string;
      number: number;
    }[];
    if (existing.length) return { url: existing[0].html_url, number: existing[0].number, created: false };
    const pr = (await this.call(repo, `/repos/${r.owner}/${r.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft }),
    })) as { html_url: string; number: number };
    return { url: pr.html_url, number: pr.number, created: true };
  }
}

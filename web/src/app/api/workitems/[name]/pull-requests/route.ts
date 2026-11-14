import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

/** ADR-0054: published pull requests compared with the current base branch. */
export const GET = handler<{ name: string }>(({ p, f, params }) => f.app.publishedPullRequests(p, params.name));

/** ADR-0054: re-publish from the publish stage; base conflicts are merged and resolved before the push. */
export const POST = handler<{ name: string }>(({ p, f, params }) => f.app.updatePullRequest(p, params.name));

import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(({ p, f, params }) => f.checkRuns.inspect(p, params.name));

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input: unknown = await req.json();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("check request must be an object");
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !["workspace", "check", "requestId"].includes(key))
    || !["workspace", "check", "requestId"].every((key) => typeof values[key] === "string" && (values[key] as string).trim().length > 0)) {
    throw new Error("workspace, check and requestId are required; commands and budgets cannot be supplied");
  }
  return f.checkRuns.submit(p, params.name, {
    workspace: values.workspace as string,
    check: values.check as string,
    requestId: values.requestId as string,
  });
});

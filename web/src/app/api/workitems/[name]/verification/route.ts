import { handler } from "@/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = handler<{ name: string }>(({ p, f, params }) => f.verification.inspect(p, params.name));

export const POST = handler<{ name: string }>(async ({ req, p, f, params }) => {
  const input: unknown = await req.json();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("verification request must be an object");
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !["workflow", "requestId"].includes(key))
    || values.workflow !== "factory-verified"
    || typeof values.requestId !== "string"
    || !values.requestId.trim()
    || values.requestId.length > 200) {
    throw new Error("workflow must be factory-verified and requestId is required (at most 200 characters); publication cannot be enabled");
  }
  return f.verification.migrate(p, params.name, {
    workflow: values.workflow,
    requestId: values.requestId,
  });
});

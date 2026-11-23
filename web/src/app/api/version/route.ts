import pkg from "../../../../package.json" with { type: "json" };

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ version: pkg.version });
}

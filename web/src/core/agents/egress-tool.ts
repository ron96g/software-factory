import type { AgentTool } from "../ports/index.ts";

/**
 * ADR-0080 §7 / SEC-5: the agent's only path to the network. It fetches through the factory's egress proxy, which
 * enforces a host allowlist and records every request, instead of letting a tool reach the internet from the factory
 * process directly. An agent opts in by declaring `fetch_url` in its `tools`.
 */
export const fetchUrlTool: AgentTool = {
  name: "fetch_url",
  readOnly: true,
  description: "Fetch a URL through the factory's egress proxy. Only allowlisted hosts are reachable and every request is recorded.",
  capabilities: ["egress"],
  guidance: "Read one documentation page or API response by its exact https URL. The host must be on the run's egress allowlist; it is not a search engine.",
  bind: (caps) => {
    const egress = caps.egress;
    if (!egress) throw new Error("fetch_url requires the egress capability");
    return {
      schema: {
        name: "fetch_url",
        description: "Fetch a URL (allowlisted hosts only; the request is recorded).",
        parameters: { type: "object", properties: { url: { type: "string", description: "Absolute https URL" } }, required: ["url"] },
      },
      invoke: async (args) => {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) throw new Error('argument "url" (string) is required');
        const r = await egress.fetch({ url });
        return `HTTP ${r.status}${r.contentType ? ` ${r.contentType}` : ""}${r.truncated ? " [truncated]" : ""}\n${r.body}`;
      },
    };
  },
};

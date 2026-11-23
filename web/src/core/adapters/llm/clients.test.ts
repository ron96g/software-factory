import test from "node:test";
import assert from "node:assert/strict";
import { googleFactory } from "./clients.ts";
import { ModelUnavailableError, type ToolCallingLLM } from "../../ports/index.ts";
import type { ModelProvider } from "../../model/kinds.ts";

const provider: ModelProvider = {
  apiVersion: "factory.ai-dlc.io/v1alpha1",
  kind: "ModelProvider",
  metadata: { name: "google", namespace: "factory-system" },
  spec: {
    type: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    secretRef: { name: "google-api-key" },
    default: true,
    models: { reasoning: "gemini-4-neon", coding: "gemini-4-neon", fast: "gemini-3.8-flash" },
  },
};

test("GoogleClient sends generateContent with x-goog-api-key and parses text + tool calls", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, headers, body });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello from gemini" }] } }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "checking" }, { functionCall: { name: "read_file", args: { path: "README.md" } } }] } }],
      }),
      { status: 200 },
    );
  };

  const client = googleFactory(fakeFetch).create(provider, "test-google-key") as ReturnType<ReturnType<typeof googleFactory>["create"]> & ToolCallingLLM;
  const text = await client.complete({
    tier: "fast",
    json: true,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ],
  });
  assert.equal(text, "hello from gemini");
  assert.equal(requests[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(requests[0].headers["x-goog-api-key"], "test-google-key");
  assert.deepEqual(requests[0].body.generationConfig, { responseMimeType: "application/json" });

  const turn = await client.completeWithTools({
    tier: "coding",
    messages: [{ role: "user", content: "Read README" }],
    tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  });
  assert.equal(requests[1].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
  assert.equal(turn.text, "checking");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, "read_file");
  assert.deepEqual(turn.toolCalls[0].arguments, { path: "README.md" });
});

test("GoogleClient maps HTTP 429 to ModelUnavailableError", async () => {
  const fakeFetch: typeof fetch = async () => new Response("rate limited", { status: 429, headers: { "retry-after": "15" } });
  const client = googleFactory(fakeFetch).create(provider, "test-google-key");
  await assert.rejects(
    () => client.complete({ messages: [{ role: "user", content: "Hi" }] }),
    (e: unknown) => e instanceof ModelUnavailableError && e.status === 429 && e.retryAfterMs === 15_000,
  );
});

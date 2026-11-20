import test from "node:test";
import assert from "node:assert/strict";
import type { CoreV1Api } from "@kubernetes/client-node";
import { KubeSecretReader } from "./secret-reader.ts";

test("KubeSecretReader lists one namespace and decodes base64 data", async () => {
  const asked: string[] = [];
  const api = {
    listNamespacedSecret: async (p: { namespace: string }) => {
      asked.push(p.namespace);
      return { items: [{ metadata: { name: "tok" }, data: { value: Buffer.from("s3cret").toString("base64") } }, { data: {} }] };
    },
  } as unknown as CoreV1Api;
  const out = await new KubeSecretReader(api).readSecrets("factory-secrets");
  assert.deepEqual(asked, ["factory-secrets"]);
  assert.deepEqual(out, { tok: { value: "s3cret" } });
});

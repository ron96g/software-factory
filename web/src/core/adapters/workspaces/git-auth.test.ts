import assert from "node:assert/strict";
import { test } from "node:test";
import type { Repository } from "../../model/kinds.ts";
import { gitRemote } from "./git-auth.ts";

test("git reaches the remote through the factory's proxy and CA settings, without any other factory environment", () => {
  const repo = { metadata: { name: "r" }, spec: { git: { url: "https://github.com/o/r.git", secretRef: { name: "token" } } } } as unknown as Repository;
  const { env } = gitRemote(repo, { resolve: () => "s3cret" }, {
    PATH: "/bin", HOME: "/home/f", https_proxy: "http://proxy:3128", NO_PROXY: "localhost", GIT_SSL_CAINFO: "/etc/ca.pem", FACTORY_DB_PASSWORD: "x",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(env.https_proxy, "http://proxy:3128");
  assert.equal(env.NO_PROXY, "localhost");
  assert.equal(env.GIT_SSL_CAINFO, "/etc/ca.pem");
  assert.equal(env.FACTORY_DB_PASSWORD, undefined);
  assert.match(env.GIT_CONFIG_PARAMETERS!, /extraheader=AUTHORIZATION: basic /);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});
